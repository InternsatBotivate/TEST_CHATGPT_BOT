import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { refreshSchema } from "./refreshSchema.js";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 🧩 Load schema dynamically
let schema = [];
const loadSchema = () => {
  try {
    const schemaPath = path.join(__dirname, "schema.json");
    if (fs.existsSync(schemaPath)) {
      schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      console.log(`✅ Schema loaded with ${schema.length} columns`);
    } else {
      console.warn("⚠️ schema.json not found. Run /ai/refresh to generate.");
    }
  } catch (err) {
    console.error("❌ Error loading schema:", err);
  }
};
loadSchema();

// 🧠 POST /ai/query — generate & run SQL
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
   - "purchase order", "PO pending", or "pending PO" → "PO_Pending"
   - "purchase receipt" → "Purchase_Receipt"
   - "tasks" or "checklist" → "Checklist"
   - "delegation" → "Delegation"
   - "store out" → "Store_OUT"
   - "store in" → "Store_IN"
   - "souda" or "sauda" → "Souda"
   - "invoice" → "INVOICE"
   - "employee" or "staff" → "Active_Employee_Details"
4. Add WHERE or LIMIT clauses if the question mentions "pending", "latest", or "summary".
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
      throw new Error("Only SELECT queries are allowed.");

    // ⚙️ Execute query via Supabase RPC
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

// 🔁 GET /ai/refresh — reload schema
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

// 🧾 GET /openapi.json — serve OpenAPI schema
app.get("/openapi.json", (req, res) => {
  const openapiPath = path.join(__dirname, "openapi.json");
  try {
    const spec = fs.readFileSync(openapiPath, "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(spec);
  } catch (err) {
    console.error("❌ Failed to load openapi.json:", err);
    res.status(500).json({ error: "Cannot load openapi.json" });
  }
});

// 🩵 Health check
app.get("/", (req, res) => {
  res.json({
    message:
      "✅ Business Bot API is live. POST /ai/query with { question: '...' }",
  });
});

export default app;
