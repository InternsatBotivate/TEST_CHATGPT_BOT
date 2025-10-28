import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// Initialize Supabase + OpenAI
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory schema cache
let cachedSchema = null;
let lastRefreshedAt = null;

// --- Refresh Schema Endpoint ---
app.get("/ai/refresh", async (req, res) => {
  try {
    const { data, error } = await supabase.rpc("get_schema");
    if (error) throw error;

    cachedSchema = data;
    lastRefreshedAt = new Date().toISOString();
    console.log(`✅ Schema refreshed: ${data.length} columns cached`);

    res.json({ success: true, columns: data.length, refreshed_at: lastRefreshedAt });
  } catch (err) {
    console.error("❌ Schema refresh failed:", err.message);
    res
      .status(500)
      .json({ error: "Schema refresh failed", details: err.message });
  }
});

// --- Query Endpoint ---
app.post("/ai/query", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) throw new Error("Missing 'question' in request body");

    // Refresh schema automatically if empty or older than 24 hours
    const needsRefresh =
      !cachedSchema ||
      (lastRefreshedAt &&
        Date.now() - new Date(lastRefreshedAt).getTime() > 24 * 60 * 60 * 1000);

    if (needsRefresh) {
      const { data } = await supabase.rpc("get_schema");
      cachedSchema = data;
      lastRefreshedAt = new Date().toISOString();
    }

    const schemaText = JSON.stringify(cachedSchema, null, 2);

    // ✅ All your prompt rules consolidated here
    const prompt = `
You are an AI expert in writing PostgreSQL queries.

⚙️ **Rules:**
1. Always wrap table and column names that contain uppercase letters or underscores in double quotes ("").
2. Only generate SELECT statements; no inserts, updates, or deletes.
3. Use the following table mappings when generating queries:

   - "purchase order", "pending po" → table **"PO_Pending"**
   - "purchase receipt" → table **"Purchase_Receipt"**
   - "tasks", "checklist" → table **"Checklist"**
   - "delegation" → table **"Delegation"**
   - "store out" → table **"Store_OUT"**
   - "store in" → table **"Store_IN"**
   - "souda" or "sauda" → table **"Souda"**
   - "invoice" → table **"INVOICE"**
   - "employee", "staff" → table **"Active_Employee_Details"**

4. For **PO_Pending**:
   - There is **no status column**.
   - Use filters like:
     - "Qty > 0" → pending
     - "Lead_Time_To_Lift_Total_Qty" for delivery comparison
     - "ERP_Po_Number" for specific order lookup.

5. Each table has columns relevant to its category. Use only those visible in the schema below.
6. Never invent table or column names.
7. Include **WHERE**, **LIMIT**, or **ORDER BY** when summarizing or filtering.
8. Format query cleanly for execution.
9. Return only SQL code, no explanation or markdown.

🧾 Schema (table_name, column_name, data_type):
${schemaText}

User question: "${question}"
`;

    // Generate SQL with OpenAI
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [{ role: "user", content: prompt }],
    });

    const sql = aiResponse.choices[0].message.content
      .replace(/```sql|```/g, "")
      .trim();

    if (!sql.toLowerCase().startsWith("select"))
      throw new Error("Only SELECT queries are allowed");

    // Run query in Supabase
    const { data, error } = await supabase.rpc("run_sql", { query_text: sql });
    if (error) throw error;

    res.json({
      summary: `Fetched ${data.length} rows for "${question}"`,
      sql,
      table: data,
    });
  } catch (err) {
    console.error("❌ Query failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Start Server ---
app.listen(4000, () =>
  console.log("✅ Business Bot API is live. POST /ai/query with { question: '...' }")
);

export default app;
