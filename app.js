const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const mysql = require("mysql2/promise");
const multer = require("multer");
const { parse } = require("csv-parse");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "tmp/" });


// CSVエラー対策（失敗行の再ダウンロード）用
const { stringify } = require("csv-stringify/sync");
const crypto = require("crypto");

// 失敗行を一時保存（メモリ）: download_id -> { createdAt, table, rows }
const failedCsvStore = new Map();

// 10分経ったら掃除（雑にでOK）
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of failedCsvStore.entries()) {
    if (now - val.createdAt > 10 * 60 * 1000) failedCsvStore.delete(key);
  }
}, 60 * 1000);


// ===== settings =====
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));

// ===== DB pool (HOST/PORT方式) =====
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT),
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4",
});

// ✅ あなたのDBにあるマスタ一覧（ここを増減すればUIも自動で変わる）
const MASTERS = [
  { key: "lcd", label: "LCD", table: "LCD_master" },
  { key: "led", label: "LED", table: "LED_master" },
  { key: "ledOthers", label: "LED Others", table: "LED_others_master" },
  { key: "matrix", label: "Matrix Switcher", table: "matrix_switcher_master" },
  { key: "tvwallCtrl", label: "TV Wall Controller", table: "TVwall_controller_master" },
  { key: "studia", label: "STUDIA", table: "STUDIA_master" },
  { key: "stand", label: "e-board Stand", table: "e_board_stand_master" },
  { key: "ops", label: "OPS", table: "OPS_master" },
  { key: "dongle", label: "Dongle", table: "dongle_master" },
  { key: "player", label: "Player", table: "player_master" },
];

// ✅ ホワイトリスト（許可テーブル）
const ALLOWED_TABLES = new Set(MASTERS.map((m) => m.table));

/**
 * ✅ URL/フォームから来た table を“許可リスト”に通して safeTable を返す
 * - OKなら tableName を返す
 * - NGなら null
 */
function getSafeTable(tableName) {
  if (!tableName) return null;
  return ALLOWED_TABLES.has(tableName) ? tableName : null;
}

// supplierテーブル名（固定）
const SUPPLIER_TABLE = "supplier_master";

// ===== column cache（テーブルごとに一度だけ調べる）=====
const tableColumnsCache = new Map();

async function getTableColumns(tableName) {
  const safeTable = getSafeTable(tableName);
  if (!safeTable) throw new Error("不正なテーブル指定です");

  if (tableColumnsCache.has(safeTable)) return tableColumnsCache.get(safeTable);

  const [cols] = await pool.execute(`SHOW COLUMNS FROM \`${safeTable}\``);
  const names = cols.map((c) => c.Field);
  tableColumnsCache.set(safeTable, names);
  return names;
}


// ===== helpers =====
async function fetchMasterList(tableName) {
  // 念のため（MASTERSから呼んでいるので基本不要だが安全）
  if (!ALLOWED_TABLES.includes(tableName)) {
    throw new Error(`Invalid table: ${tableName}`);
  }

  const cols = await getTableColumns(tableName);

  // それぞれ「存在するなら表示」「無ければNULL」を返す
  const hasInch = cols.includes("inch");
  const hasSupplierId = cols.includes("supplier_id");

  const selectInch = hasInch ? "t.`inch` AS inch" : "NULL AS inch";
  const selectSupplierName = hasSupplierId ? "s.`name` AS supplier_name" : "NULL AS supplier_name";

  const joinSupplier = hasSupplierId
    ? `LEFT JOIN \`${SUPPLIER_TABLE}\` s ON s.\`id\` = t.\`supplier_id\``
    : "";

  // PN2 は「全マスタにある前提」
  const sql = `
    SELECT
      t.\`id\`,
      t.\`PN2\` AS label,
      ${selectInch},
      ${selectSupplierName},
      t.\`is_active\`
    FROM \`${tableName}\` t
    ${joinSupplier}
    ORDER BY t.\`id\` ASC
  `;

  const [rows] = await pool.execute(sql);
  return rows;
}

// ===== routes =====
app.get("/", (req, res) => res.redirect("/masters"));

app.get("/masters", async (req, res) => {
  try {
    const mastersData = await Promise.all(
      MASTERS.map(async (m) => {
        const rows = await fetchMasterList(m.table);
        return { ...m, rows };
      })
    );

    res.render("master", { mastersData });
  } catch (err) {
    console.error(err);
    res.status(500).send("マスタ取得に失敗しました");
  }
});

// 詳細ページ
app.get("/masters/:table/:id", async (req, res) => {
  const { table, id } = req.params;

  if (!ALLOWED_TABLES.includes(table)) {
    return res.status(400).send("Invalid table");
  }

  const safeId = Number(id);
  if (!Number.isInteger(safeId)) {
    return res.status(400).send("Invalid id");
  }

  try {
    const [rows] = await pool.execute(`SELECT * FROM \`${table}\` WHERE id = ?`, [safeId]);

    if (!rows || rows.length === 0) {
      return res.status(404).send("Not found");
    }

    res.render("master_detail", {
      table,
      row: rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("DB error");
  }
});

// 新規登録ページ
app.get("/masters/register", (req, res) => {
  res.render("master_register");
});


// GET（画面）
// ===== CSVアップロード画面 =====
app.get("/masters/upload", (req, res) => {
  const safeTable = getSafeTable(req.query.table);
  // 不正なtableは空にして画面表示（操作はPOSTで弾く）
  res.render("master_upload", { table: safeTable || "" });
});

app.post("/masters/upload", upload.single("csv"), async (req, res) => {
  let filePath;

  try {
    // ① ファイルチェック
    if (!req.file) return res.status(400).send("CSVファイルがありません");
    filePath = req.file.path;

    // ② tableチェック（ホワイトリスト）
    const safeTable = getSafeTable(req.body.table);
    if (!safeTable) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).send("不正なマスタ指定です");
    }

    // ③ テーブルのカラム一覧を取得（存在する列だけINSERTするため）
    const tableCols = await getTableColumns(safeTable);
    const insertableCols = tableCols.filter((c) => !["id", "created_at", "updated_at"].includes(c));

    // ④ CSV読み込み
    const records = await new Promise((resolve, reject) => {
      const rows = [];
      fs.createReadStream(filePath)
        .pipe(parse({ columns: true, skip_empty_lines: true, trim: true }))
        .on("data", (row) => rows.push(row))
        .on("end", () => resolve(rows))
        .on("error", reject);
    });

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // ⑤ 1行ずつ登録して、失敗行を集める
    const okRows = [];
    const failedRows = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNumber = i + 2; // 1行目ヘッダ想定

      try {
        // ---- CSV列名とDBカラム名が一致しているものだけ拾う ----
        // 例：CSVにPN2, inch, is_activeがあれば入るし、無ければ入らない
        const colsToUse = insertableCols.filter((col) => Object.prototype.hasOwnProperty.call(row, col));

        if (colsToUse.length === 0) {
          throw new Error("CSVの列名とDBカラムが一致しません（挿入できる列が0件）");
        }

        // ---- 値整形：空文字はnullに寄せる（必要に応じて追加）----
        const values = colsToUse.map((col) => {
          const v = row[col];

          if (v === undefined) return null;
          if (v === "") return null;
          if (v === "NULL") return null;

          // is_active は 0/1 に寄せたい（列が存在する場合のみ）
          if (col === "is_active") return Number(v);

          // inch は数値っぽく
          if (col === "inch") return v === "" ? null : Number(v);

          // TF系は "あり/なし", "true/false", "1/0" など想定があるなら後でここに寄せる
          // 今は一旦そのまま
          return v;
        });

        // ---- 必須チェック（最低限PN2があれば）----
        if (Object.prototype.hasOwnProperty.call(row, "PN2")) {
          const PN2 = String(row.PN2 || "").trim();
          if (!PN2) throw new Error("PN2が空");
        }

        // ---- INSERT実行 ----
        const colsSql = colsToUse.map((c) => `\`${c}\``).join(", ");
        const placeholders = colsToUse.map(() => "?").join(", ");

        await pool.execute(
          `INSERT INTO \`${safeTable}\` (${colsSql}) VALUES (${placeholders})`,
          values
        );

        okRows.push(row);

      } catch (err) {
        failedRows.push({
          ...row,
          __row: rowNumber,
          __reason: err.code ? `${err.code}: ${err.message}` : err.message,
        });
      }
    }

    // ⑥ 失敗行があればdownload_id発行
    let downloadId = null;
    if (failedRows.length > 0) {
      downloadId = crypto.randomUUID();
      failedCsvStore.set(downloadId, {
        createdAt: Date.now(),
        table: safeTable,
        rows: failedRows,
      });
    }

    // ⑦ resultへ渡す（成功件数も出す）
    res.render("master_upload_result", {
      table: safeTable,
      count: records.length,
      okCount: okRows.length,
      failedCount: failedRows.length,
      preview: records.slice(0, 5),
      downloadId,
    });

  } catch (err) {
    console.error(err);
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).send("CSV取込に失敗しました");
  }
});



// CSV失敗行ダウンロード用ルート
app.get("/masters/upload/failed/:id.csv", (req, res) => {
  const id = req.params.id;
  const data = failedCsvStore.get(id);

  if (!data) return res.status(404).send("期限切れ or データがありません");

  // 失敗行CSVを生成（__reason, __row も含める）
  const csv = stringify(data.rows, {
    header: true
  });

  const filename = `failed_rows_${data.table}_${new Date().toISOString().slice(0,10)}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // Excel対策：UTF-8 BOM
  res.send("\uFEFF" + csv);
});




// 共通API：is_active トグル
app.post("/toggle-active", async (req, res) => {
  const { table, id } = req.body;

  if (!table || !id) return res.status(400).json({ error: "table と id が必要です" });
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: "Invalid table" });

  const safeId = Number(id);
  if (!Number.isInteger(safeId)) return res.status(400).json({ error: "Invalid id" });

  try {
    const [result] = await pool.execute(
      `UPDATE \`${table}\`
       SET is_active = IF(is_active = 1, 0, 1)
       WHERE id = ?`,
      [safeId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "対象レコードが見つかりません" });
    }

    const [rows] = await pool.execute(
      `SELECT id, is_active FROM \`${table}\` WHERE id = ?`,
      [safeId]
    );

    res.json({ success: true, id: safeId, is_active: rows[0]?.is_active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log("DB ENV", {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_NAME: process.env.DB_NAME,
  });
  console.log(`✅ http://localhost:${port}`);
});
