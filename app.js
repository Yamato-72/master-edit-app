// app.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const mysql = require("mysql2/promise");
const multer = require("multer");
const { parse } = require("csv-parse");
const fs = require("fs");

const { stringify } = require("csv-stringify/sync");
const crypto = require("crypto");

const app = express();
const upload = multer({ dest: "tmp/" });

// ===== settings =====
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));

// ===== DB pool =====
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

console.log("DB ENV:", {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  name: process.env.DB_NAME,
  user: process.env.DB_USER,
  hasPass: !!process.env.DB_PASSWORD,
});

// supplierテーブル名（固定）
const SUPPLIER_TABLE = "supplier_master";

// ===== 失敗CSV再DL用 store =====
const failedCsvStore = new Map();
// 10分で掃除
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of failedCsvStore.entries()) {
    if (now - val.createdAt > 10 * 60 * 1000) failedCsvStore.delete(key);
  }
}, 60 * 1000);

// ===== master tables cache =====
// 「DBに追加したらすぐ反映」が欲しいのでTTL短め
const MASTER_TABLES_TTL_MS = 30 * 1000;
let masterTablesCache = { at: 0, tables: [] };

async function fetchMasterTablesFresh() {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME LIKE '%\\_master'
     ORDER BY TABLE_NAME`,
    [process.env.DB_NAME]
  );
  return rows.map((r) => r.TABLE_NAME);
}

async function getMasterTables() {
  const now = Date.now();
  if (now - masterTablesCache.at < MASTER_TABLES_TTL_MS && masterTablesCache.tables.length > 0) {
    return masterTablesCache.tables;
  }
  const tables = await fetchMasterTablesFresh();
  masterTablesCache = { at: now, tables };
  return tables;
}

async function buildAllowedTables() {
  const tables = await getMasterTables();
  return new Set(tables);
}

function getSafeTable(tableName, allowedTables) {
  if (!tableName) return null;
  return allowedTables.has(tableName) ? tableName : null;
}

// ===== column cache（テーブルごとに一度だけ）=====
const tableColumnsCache = new Map();

async function getTableColumns(tableName, allowedTables) {
  const safeTable = getSafeTable(tableName, allowedTables);
  if (!safeTable) throw new Error("不正なテーブル指定です");

  if (tableColumnsCache.has(safeTable)) return tableColumnsCache.get(safeTable);

  const [cols] = await pool.execute(`SHOW COLUMNS FROM \`${safeTable}\``);
  const names = cols.map((c) => c.Field);
  tableColumnsCache.set(safeTable, names);
  return names;
}

// ===== helpers =====
function toTabLabel(tableName) {
  // 例: matrix_switcher_master -> MATRIX SWITCHER
  return String(tableName)
    .replace(/_master$/i, "")
    .replace(/_/g, " ")
    .trim()
    .toUpperCase();
}

async function fetchMasterList(tableName, allowedTables) {
  if (!allowedTables.has(tableName)) {
    throw new Error(`Invalid table: ${tableName}`);
  }

  const cols = await getTableColumns(tableName, allowedTables);

  // 存在チェック
  const hasPN2 = cols.includes("PN2");
  const hasName = cols.includes("name");
  const hasInch = cols.includes("inch");
  const hasSupplierId = cols.includes("supplier_id");
  const hasIsActive = cols.includes("is_active");

  // ラベル：PN2 → name → id（最後の手段）
  const selectLabel = hasPN2
    ? "t.`PN2`"
    : hasName
    ? "t.`name`"
    : "CAST(t.`id` AS CHAR)";

  // inch / supplier / is_active は「無ければNULL」
  const selectInch = hasInch ? "t.`inch` AS inch" : "NULL AS inch";
  const selectSupplierName = hasSupplierId ? "s.`name` AS supplier_name" : "NULL AS supplier_name";
  const selectIsActive = hasIsActive ? "t.`is_active` AS is_active" : "NULL AS is_active";

  const joinSupplier = hasSupplierId
    ? `LEFT JOIN \`${SUPPLIER_TABLE}\` s ON s.\`id\` = t.\`supplier_id\``
    : "";

  const sql = `
    SELECT
      t.\`id\` AS id,
      ${selectLabel} AS label,
      ${selectInch},
      ${selectSupplierName},
      ${selectIsActive}
    FROM \`${tableName}\` t
    ${joinSupplier}
    ORDER BY t.\`id\` ASC
  `;

  const [rows] = await pool.execute(sql);
  return { rows, cols }; // colsも返す（トグル可否判定に使う）
}

// ===== routes =====
app.get("/", (req, res) => res.redirect("/masters"));

app.get("/masters", async (req, res) => {
  try {
    const tables = await getMasterTables();
    const allowedTables = new Set(tables);

    const mastersData = await Promise.all(
      tables.map(async (table) => {
        const { rows, cols } = await fetchMasterList(table, allowedTables);

        return {
          key: table,               // data-target用
          label: toTabLabel(table), // タブ表示名（自由に変えてOK）
          table,
          rows,
          // UI側で「is_active列がある時だけボタン出す」などに使える
          hasIsActive: cols.includes("is_active"),
        };
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

  const allowedTables = await buildAllowedTables();
  if (!allowedTables.has(table)) {
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

// 新規登録ページ（※クエリ ?table=xxx_master 必須）
app.get("/masters/register", async (req, res) => {
  const table = req.query.table;

  const allowedTables = await buildAllowedTables();
  const safeTable = getSafeTable(table, allowedTables);
  if (!safeTable) {
    return res.status(400).send("不正なテーブル指定です");
  }

  try {
    const [columns] = await pool.query(
      `
      SELECT
        COLUMN_NAME,
        DATA_TYPE,
        COLUMN_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        CHARACTER_MAXIMUM_LENGTH,
        NUMERIC_PRECISION,
        NUMERIC_SCALE,
        EXTRA
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
      `,
      [process.env.DB_NAME, safeTable]
    );

    res.render("master_register", {
      table: safeTable,
      columns,
    });
  } catch (err) {
    console.error("カラム取得エラー:", err);
    res.status(500).send("カラム情報の取得に失敗しました");
  }
});

// 新規登録実行
app.post("/masters/register", async (req, res) => {
  const table = req.query.table;

  const allowedTables = await buildAllowedTables();
  const safeTable = getSafeTable(table, allowedTables);
  if (!safeTable) {
    return res.status(400).send("不正なテーブル指定です");
  }

  try {
    const [columns] = await pool.query(
      `
      SELECT COLUMN_NAME, EXTRA
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      `,
      [process.env.DB_NAME, safeTable]
    );

    const insertColumns = [];
    const insertValues = [];

    columns.forEach((col) => {
      // auto_increment は除外
      if (col.EXTRA && col.EXTRA.includes("auto_increment")) return;

      const value = req.body[col.COLUMN_NAME];

      // 未送信 or 空文字 → null
      if (value === undefined || value === "") {
        insertColumns.push(col.COLUMN_NAME);
        insertValues.push(null);
      } else {
        insertColumns.push(col.COLUMN_NAME);
        insertValues.push(value);
      }
    });

    const placeholders = insertColumns.map(() => "?").join(",");
    const sql = `
      INSERT INTO \`${safeTable}\`
      (${insertColumns.map(c => `\`${c}\``).join(",")})
      VALUES (${placeholders})
    `;

    await pool.query(sql, insertValues);

    // 一覧へ戻す
    res.redirect(`/masters`);
  } catch (err) {
    console.error("登録エラー:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).send("既に登録されている値があります（重複エラー）");
    }

    res.status(500).send("登録に失敗しました");
  }
});

// ===== CSVアップロード画面 =====
app.get("/masters/upload", async (req, res) => {
  const allowedTables = await buildAllowedTables();
  const safeTable = getSafeTable(req.query.table, allowedTables);
  res.render("master_upload", { table: safeTable || "" });
});

app.post("/masters/upload", upload.single("csv"), async (req, res) => {
  let filePath;

  try {
    // ① ファイルチェック
    if (!req.file) return res.status(400).send("CSVファイルがありません");
    filePath = req.file.path;

    // ② tableチェック（動的ホワイトリスト）
    const allowedTables = await buildAllowedTables();
    const safeTable = getSafeTable(req.body.table, allowedTables);
    if (!safeTable) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).send("不正なマスタ指定です");
    }

    // ③ テーブルのカラム一覧取得
    const tableCols = await getTableColumns(safeTable, allowedTables);
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
        const colsToUse = insertableCols.filter((col) =>
          Object.prototype.hasOwnProperty.call(row, col)
        );

        if (colsToUse.length === 0) {
          throw new Error("CSVの列名とDBカラムが一致しません（挿入できる列が0件）");
        }

        const values = colsToUse.map((col) => {
          const v = row[col];

          if (v === undefined || v === "" || v === "NULL") return null;

          if (col === "is_active") return Number(v);
          if (col === "inch") return v === "" ? null : Number(v);

          return v;
        });

        // 最低限の必須チェック例：PN2が存在するテーブルなら空は禁止
        if (tableCols.includes("PN2") && Object.prototype.hasOwnProperty.call(row, "PN2")) {
          const PN2 = String(row.PN2 || "").trim();
          if (!PN2) throw new Error("PN2が空");
        }
        // nameが存在するテーブルなら空は禁止…等もここで追加できる

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

    // ⑦ resultへ渡す
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

// CSV失敗行ダウンロード
app.get("/masters/upload/failed/:id.csv", (req, res) => {
  const id = req.params.id;
  const data = failedCsvStore.get(id);

  if (!data) return res.status(404).send("期限切れ or データがありません");

  const csv = stringify(data.rows, { header: true });
  const filename = `failed_rows_${data.table}_${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + csv); // Excel対策：UTF-8 BOM
});

// 共通API：is_active トグル（※is_active列があるテーブルのみ）
app.post("/toggle-active", async (req, res) => {
  const { table, id } = req.body;

  if (!table || !id) return res.status(400).json({ error: "table と id が必要です" });

  const allowedTables = await buildAllowedTables();
  if (!allowedTables.has(table)) return res.status(400).json({ error: "Invalid table" });

  const safeId = Number(id);
  if (!Number.isInteger(safeId)) return res.status(400).json({ error: "Invalid id" });

  try {
    // is_activeが無いテーブルは弾く
    const cols = await getTableColumns(table, allowedTables);
    if (!cols.includes("is_active")) {
      return res.status(400).json({ error: "このテーブルには is_active 列がありません" });
    }

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
