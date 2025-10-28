import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import { refreshSchema } from "./refreshSchema.js";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 🧩 Helper: Load schema dynamically (always fresh)
let schema = null;
const loadSchema = () => {
  try {
    if (fs.existsSync("./schema.json")) {
      schema = JSON.parse(fs.readFileSync("./schema.json", "utf8"));
      console.log("✅ Loaded schema.json successfully.");
    } else {
      console.warn("⚠️ schema.json not found, run /ai/refresh to create it.");
      schema = [];
    }
  } catch (err) {
    console.error("❌ Failed to load schema:", err);
    schema = [];
  }
};

// Load schema at startup
loadSchema();

// 🧠 POST /ai/query — Natural Language → SQL → Run → Return
app.post("/ai/query", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question)
      return res.status(400).json({ error: "Missing 'question' parameter" });

    const systemPrompt = `
You are an AI expert in writing PostgreSQL queries.

Rules:
1. Only generate SELECT statements; no inserts, updates, or deletes.
2. Wrap table and column names with uppercase letters or underscores in double quotes ("").
3. Use the following mappings:
   - "purchase order", "PO pending", or "pending PO" → table "PO_Pending"
   - "purchase receipt" → table "Purchase_Receipt"
   - "tasks" or "checklist" → table "Checklist"
   - "delegation" → table "Delegation"
   - "store out" → table "Store_OUT"
   - "store in" → table "Store_IN"
   - "souda" or "sauda" → table "Souda"
   - "invoice" → table "INVOICE"
   - "employee" or "staff" → table "Active_Employee_Details"
4. Add WHERE or LIMIT clauses if the query is about "pending", "latest", or "summary".
5. Schema (table_name, column_name, data_type):
${JSON.stringify(schema, null, 2)}
User question: "${question}"
Return only SQL code, no explanations.
    `;

    // 💬 Generate SQL
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
    });

    let sql = response.choices[0].message.content.trim();
    sql = sql.replace(/```sql|```/g, "").trim();
    if (!sql.toLowerCase().startsWith("select"))
      throw new Error("Only SELECT queries are allowed");

    // ⚙️ Run query in Supabase
    const { data, error } = await supabase.rpc("run_sql", { query_text: sql });
    if (error) throw error;

    res.json({
      summary: `Fetched ${data?.length || 0} rows for "${question}"`,
      sql,
      table: data,
    });
  } catch (err) {
    console.error("❌ Query error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🔁 GET /ai/refresh — Reload latest Supabase schema
app.get("/ai/refresh", async (req, res) => {
  try {
    console.log("🔄 Refreshing Supabase schema...");
    const result = await refreshSchema();
    loadSchema();
    res.json({
      success: true,
      message: "Schema refreshed successfully.",
      columns: result?.length || 0,
    });
  } catch (error) {
    console.error("❌ Schema refresh failed:", error);
    res.status(500).json({
      error: "Schema refresh failed",
      details: error.message || error.toString(),
    });
  }
});

// 🟢 Default route
app.get("/", (req, res) => {
  res.send("✅ Business Bot API is live. POST /ai/query with { question: '...' }");
});

export default app;
