// ---------- server.js ----------
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ---------- Load Schema ----------
const schema = JSON.parse(fs.readFileSync("./schema.json", "utf-8"));

// ---------- Initialize Clients ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- Health Check ----------
app.get("/", (req, res) => {
  res.send("✅ Business Bot API is live. POST /ai/query with { question: '...' }");
});

// ---------- OpenAI SQL Generator ----------
async function generateSQL(question, schema) {
  const prompt = `
You are an AI expert in writing PostgreSQL queries.

⚠️ Rules:
1. Only generate **SELECT** statements.
2. Always wrap table or column names with uppercase letters or underscores in double quotes ("").
3. Map terms to tables:
   - "purchase order", "PO pending", "pending PO" → "PO_Pending"
   - "purchase receipt" → "Purchase_Receipt"
   - "tasks", "checklist" → "Checklist"
   - "delegation" → "Delegation"
   - "store out" → "Store_OUT"
   - "store in" → "Store_IN"
   - "souda" or "sauda" → "Souda"
   - "invoice" → "INVOICE"
   - "employee" or "staff" → "Active_Employee_Details"
   ("PO_Pending" has no "status" column — use "Qty > 0" for pending.)
4. Use filters (WHERE, LIMIT) when the question implies "pending", "latest", or "summary".
5. Do NOT invent tables or columns not in the schema.

Schema (table_name, column_name, data_type):
${JSON.stringify(schema, null, 2)}

User question: "${question}"
Return only SQL code, no explanation.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  let sql = completion.choices[0].message.content.trim();
  sql = sql.replace(/```sql/g, "").replace(/```/g, "").trim();
  return sql;
}

// ---------- /ai/query Endpoint ----------
app.post("/ai/query", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Question is required." });

    const sql = await generateSQL(question, schema);
    console.log("🧠 SQL Generated:\n", sql);

    // ✅ Safety check
    if (!/^SELECT\s+/i.test(sql)) {
      return res.status(400).json({ error: "Only SELECT queries are allowed" });
    }

    // Execute SQL through Supabase RPC
    const { data, error } = await supabase.rpc("run_sql", { sql_text: sql });

    if (error) throw error;

    res.json({
      summary: `Fetched ${data?.length || 0} rows.`,
      sql,
      table: data,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
