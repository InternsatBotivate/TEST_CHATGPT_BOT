// server.js — Final Vercel-Compatible Version
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { refreshSchema } from "./refreshSchema.js";

app.get("/ai/refresh", async (req, res) => {
  try {
    const newSchema = await refreshSchema();
    res.json({ success: true, columns: newSchema.length });
  } catch (err) {
    console.error("Error refreshing schema:", err);
    res.status(500).json({ error: err.message });
  }
});


dotenv.config();

const app = express();
app.use(bodyParser.json());

// -------------- ENVIRONMENT ----------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey)
  throw new Error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");

const supabase = createClient(supabaseUrl, supabaseKey);

// -------------- SCHEMA LOADING ----------------
let schemaCache = "";
async function refreshSchema() {
  const { data, error } = await supabase.rpc("get_schema_overview");
  if (error) throw error;
  schemaCache = data
    .map((r) => `${r.table_name}(${r.column_name}:${r.data_type})`)
    .join(", ");
  console.log(`📄 Schema loaded (${data.length} columns)`);
}

// -------------- PROMPT TEMPLATE ----------------
function buildPrompt(question) {
  return `
You are an AI expert in writing PostgreSQL queries.

⚠️ Rules:
1. Always wrap table and column names containing uppercase letters or underscores in double quotes ("").
2. Only generate SELECT statements; no INSERT, UPDATE, or DELETE.
3. Use these mappings:
   - "purchase order", "pending PO", "PO pending" → "PO_Pending"
   - "purchase receipt" → "Purchase_Receipt"
   - "tasks", "checklist" → "Checklist"
   - "delegation" → "Delegation"
   - "store out" → "Store_OUT"
   - "store in" → "Store_IN"
   - "souda", "sauda" → "Souda"
   - "invoice" → "INVOICE"
   - "employee", "staff" → "Active_Employee_Details"
4. When filtering pending data, prefer columns like "Qty", "Lead_Time_To_Lift_Total_Qty", "ERP_Po_Number".
5. Use the schema to guide valid table/column names.
6. Never invent columns or run non-SELECT queries.

Schema:
${schemaCache}

User question: "${question}"

Return only SQL code, nothing else.
`;
}

// -------------- /ai/query ENDPOINT ----------------
app.post("/ai/query", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Missing question" });

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You generate SQL for Supabase PostgreSQL safely." },
        { role: "user", content: buildPrompt(question) },
      ],
    });

    let sql = chat.choices[0].message.content.trim();
    const cleaned = sql.replace(/```sql|```/g, "").trim();

    if (!/^select/i.test(cleaned))
      throw new Error("Only SELECT queries are allowed");

    const { data: rows, error: runErr } = await supabase.rpc("run_sql", { sql: cleaned });
    if (runErr) throw runErr;

    res.json({
      summary: `Fetched ${rows?.length || 0} rows for "${question}"`,
      sql: cleaned,
      table: rows?.slice(0, 20) || [],
    });
  } catch (err) {
    console.error("❌", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------- ROOT ----------------
app.get("/", (_, res) => {
  res.send("✅ Business Bot API is live. POST /ai/query with { question: '...' }");
});

// -------------- EXPORT FOR VERCEL ----------------
await refreshSchema();
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`✅ Local server running on port ${PORT}`));
}
export default app;
