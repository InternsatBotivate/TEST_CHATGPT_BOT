// server.js — final version
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

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
  const { data, error } = await supabase
    .from("information_schema.columns")
    .select("table_name,column_name,data_type")
    .eq("table_schema", "public");
  if (error) throw error;
  schemaCache = data
    .map(
      (r) => `${r.table_name}(${r.column_name}:${r.data_type})`
    )
    .join(", ");
  console.log(`📄 Schema loaded: ${data.length} columns`);
}

// -------------- PROMPT TEMPLATE ----------------
function buildPrompt(question) {
  return `
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

4. Each table has columns relevant to its category as shown in schema below.
5. Do not invent table or column names not listed in the schema.
6. Always include WHERE filters or LIMIT when the question suggests summarising, pending, or latest data.

Schema (table_name, column_name, data_type):
${schemaCache}

User question: "${question}"

Return only SQL code, no explanation.
`;
}

// -------------- /ai/query ENDPOINT ----------------
app.post("/ai/query", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Missing question" });

    // generate SQL
    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You generate SQL for Supabase Postgres safely." },
        { role: "user", content: buildPrompt(question) },
      ],
    });

    let sql = chat.choices[0].message.content.trim();
    const cleaned = sql.replace(/```sql|```/g, "").trim();

    if (!/^select/i.test(cleaned))
      throw new Error("Only SELECT queries are allowed");

    // execute through Supabase RPC
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

// -------------- STARTUP ----------------
const PORT = process.env.PORT || 4000;
refreshSchema().then(() => {
  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
});
