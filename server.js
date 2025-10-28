import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";
import OpenAI from "openai";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// --- File handling ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use("/charts", express.static(path.join(__dirname, "charts")));
if (!fs.existsSync(path.join(__dirname, "charts"))) fs.mkdirSync(path.join(__dirname, "charts"));

// --- Schema caching ---
let schema = {};
const loadSchema = () => {
  try {
    schema = JSON.parse(fs.readFileSync("./schema.json", "utf8"));
    console.log("📄 Schema loaded with", schema.length, "columns");
  } catch {
    console.warn("⚠️ No schema.json found yet");
  }
};
loadSchema();
fs.watchFile("./schema.json", loadSchema);

// --- Chart generation helper ---
async function generateChart(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const sample = data[0];
  const keys = Object.keys(sample);
  const numericKeys = keys.filter(k => typeof sample[k] === "number");
  const labelKey = keys.find(k => !numericKeys.includes(k)) || keys[0];
  const valueKey = numericKeys[0];
  if (!valueKey) return null;

  const width = 800, height = 450;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });
  const config = {
    type: "bar",
    data: {
      labels: data.map(r => r[labelKey]),
      datasets: [{
        label: valueKey,
        data: data.map(r => r[valueKey]),
        backgroundColor: "rgba(54,162,235,0.6)"
      }]
    },
    options: { responsive: false }
  };
  const buffer = await chartJSNodeCanvas.renderToBuffer(config);
  const fileName = `chart_${Date.now()}.png`;
  const filePath = path.join(__dirname, "charts", fileName);
  fs.writeFileSync(filePath, buffer);
  return `/charts/${fileName}`;
}

// --- Core endpoint ---
app.post("/ai/query", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "Missing question" });

  try {
    // 1️⃣ Build prompt with schema context
    const prompt = `
You are an AI expert in writing PostgreSQL queries.
⚠️ Always wrap table and column names in double quotes ("") because this database uses uppercase and underscores.
Use this schema to write a safe, read-only PostgreSQL SELECT query.
Schema (table_name, column_name, data_type):
${JSON.stringify(schema, null, 2)}

User question: "${question}"
Return only SQL code, no explanations.
    `;

    // 2️⃣ Ask OpenAI for SQL
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    });

    let sql = completion.choices[0].message.content.trim();

    // 3️⃣ Clean up markdown & semicolons
    sql = sql.replace(/```sql|```/gi, "").trim();
    sql = sql.replace(/;+\s*$/, "").trim();

    console.log("🧠 Cleaned SQL:\n", sql);

    // 4️⃣ Validate basic safety
    if (!/^select/i.test(sql))
      throw new Error("Unsafe or invalid query generated");

    // 5️⃣ Execute on Supabase
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sql })
    });

    const data = await rpcRes.json();
    if (!rpcRes.ok) throw new Error(JSON.stringify(data));
    console.log(`📊 Returned ${data.length} rows`);

    // 6️⃣ Generate chart
    const chartURL = await generateChart(data);

    res.json({
      summary: `Fetched ${data.length} rows.`,
      sql,
      table: data.slice(0, 50),
      chart: chartURL ? `${req.protocol}://${req.get("host")}${chartURL}` : null
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
