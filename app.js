const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const mysql = require("mysql2/promise");

const app = express();

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

const ALLOWED_TABLES = MASTERS.map((m) => m.table);

// supplierテーブル名（固定）
const SUPPLIER_TABLE = "supplier_master";

// ===== column cache（テーブルごとに一度だけ調べる）=====
const tableColumnsCache = new Map();

async function getTableColumns(tableName) {
  if (tableColumnsCache.has(tableName)) return tableColumnsCache.get(tableName);

  const [cols] = await pool.execute(`SHOW COLUMNS FROM \`${tableName}\``);
  const names = cols.map((c) => c.Field);
  tableColumnsCache.set(tableName, names);
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
