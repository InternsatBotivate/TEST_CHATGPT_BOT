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

// --- Set up writable chart directory ---
const chartDir = "/tmp/charts"; // ✅ /tmp is writable on Vercel
if (!fs.existsSync(chartDir)) fs.mkdirSync(chartDir, { recursive: true });
app.use("/charts", express.static(chartDir));

// --- Schema caching ---
let schema = {};
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const loadSchema = () => {
  try {
    schema = JSON.parse(fs.readFileSync("./schema.json", "utf8"));
    console.log("📄 Schema loaded with", schema.length, "columns");
  } catch {
    console.warn("⚠️ No schema.json found yet or invalid");
  }
};
loadSchema();
fs.watchFile("./schema.json", loadSchema);

// --- Chart generator ---
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
      datasets: [
        {
          label: valueKey,
          data: data.map(r => r[valueKey]),
          backgroundColor: "rgba(54,162,235,0.6)"
        }
      ]
    },
    options: { responsive: false }
  };

  const buffer = await chartJSNodeCanvas.renderToBuffer(config);
  const fileName = `chart_${Date.now()}.png`;
  const filePath = path.join(chartDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return `/charts/${fileName}`;
}

// --- Core AI Query Endpoint ---
app.post("/ai/query", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "Missing question" });

  try {
    const prompt = `
You are an AI expert in writing PostgreSQL queries.

⚠️ Rules:
1. Always wrap table and column names that contain uppercase letters or underscores in double quotes ("").
2. Only generate SELECT statements; no inserts, updates, or deletes.
3. Use the following table mappings when generating queries:

   - When the user says "purchase order", "PO pending", or "pending PO" → use table "PO_Pending"
   - When the user says "purchase receipt" → use table "Purchase_Receipt"
   - When the user says "tasks" or "checklist" → use table "Checklist"
   - When the user says "delegation" → use table "Delegation"
   - When the user says "store out" → use table "Store_OUT"
   - When the user says "store in" → use table "Store_IN"
   - When the user says "souda" or "sauda" → use table "Souda"
   - When the user says "invoice" → use table "INVOICE"
   - When the user says "employee" or "staff" → use table "Active_Employee_Details"
   - When the user says "purchase order", "pending po", or "po pending" → use table "PO_Pending".
   There is **no** "status" column here.
   Use filters based on available columns like:
    - "Qty" (e.g., Qty > 0 means pending)
    - "Lead_Time_To_Lift_Total_Qty" if comparing delivery progress
    - or "ERP_Po_Number" for specific order identification.


4. Each table has columns relevant to its category, which can be seen in the schema below. 
5. Do not invent table or column names not listed in the schema.
6. Always include WHERE filters or LIMIT clauses when the question suggests summarising, pending, or latest data.

Schema (table_name, column_name, data_type):
${JSON.stringify(schema, null, 2)}

User question: "${question}"
Return only SQL code, no explanations.
`;


    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    });

    let sql = completion.choices[0].message.content.trim();
    sql = sql.replace(/```sql|```/gi, "").trim();
    sql = sql.replace(/;+\s*$/, "").trim();

    console.log("🧠 Cleaned SQL:\n", sql);

    if (!/^select/i.test(sql))
      throw new Error("Unsafe or invalid query generated");

    // --- Execute query on Supabase ---
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

    // --- Generate chart ---
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
