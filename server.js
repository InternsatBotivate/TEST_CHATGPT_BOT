import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import fs from "fs";

// Load schema from local file
const schema = JSON.parse(fs.readFileSync("./schema.json", "utf-8"));

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ✅ make sure this matches your Vercel env variable name
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🧠 Root route (health check)
app.get("/", (req, res) => {
  res.send("✅ Business Bot API is live. POST /ai/query with { question: '...' }");
});

// 🧩 Generate SQL query using OpenAI
async function generateSQL(question, schema) {
  const prompt = `
You are an AI expert in writing PostgreSQL queries.

⚠️ Rules:
1. Always wrap table and column names that contain uppercase letters or underscores in double quotes ("").
2. Only generate SELECT statements; no inserts, updates, or deletes.
3. Use the following table mappings when generating queries:
   - "purchase order", "PO pending", "pending PO" → "PO_Pending"
   - "purchase receipt" → "Purchase_Receipt"
   - "tasks" or "checklist" → "Checklist"
   - "delegation" → "Delegation"
   - "store out" → "Store_OUT"
   - "store in" → "Store_IN"
   - "souda" or "sauda" → "Souda"
   - "invoice" → "INVOICE"
   - "employee" or "staff" → "Active_Employee_Details"
   There is no "status" column in "PO_Pending"; use filters like "Qty > 0" for pending.

Schema (table_name, column_name, data_type):
${JSON.stringify(schema, null, 2)}

User question: "${question}"
Return only SQL code, no explanations.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  let sql = completion.choices[0].message.content.trim();
  sql = sql.replace(/```sql/g, "").replace(/```/g, "").trim(); // ✅ cleanup markdown
  return sql;
}

// 🧠 POST /ai/query
app.post("/ai/query", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Question is required." });

    const sql = await generateSQL(question, schema);
    console.log("🧠 Cleaned SQL:\n", sql);

    // ✅ Safety check — allow only SELECT
    if (!/^SELECT\s+/i.test(sql)) {
      return res.status(400).json({ error: "Only SELECT queries are allowed" });
    }

    const { data, error } = await supabase.from("PO_Pending").select("*").limit(10);

    if (error) throw error;

    res.json({
      summary: `Fetched ${data.length} rows.`,
      sql,
      table: data,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
