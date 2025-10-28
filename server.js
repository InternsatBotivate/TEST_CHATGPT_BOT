// server.js
import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const app = express();
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const schemaPath = path.resolve("schema.json");
let schema = fs.existsSync(schemaPath)
  ? fs.readFileSync(schemaPath, "utf8")
  : "Schema not found.";

// simple home route
app.get("/", (req, res) => {
  res.send("✅ Business Bot API is live. POST /ai/query with { question: '...' }");
});

app.post("/ai/query", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "Question missing" });

  try {
    const systemPrompt = `
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
      • "Qty" (e.g., Qty > 0 means pending)
      • "Lead_Time_To_Lift_Total_Qty" if comparing delivery progress
      • or "ERP_Po_Number" for specific order identification.

4. Each table has columns relevant to its category, visible in the schema below.
5. Do not invent table or column names not listed in the schema.
6. Always include WHERE filters or LIMIT clauses when summarizing, pending, or latest data.

Schema (table_name, column_name, data_type):
${schema}

User question: "${question}"
Return only SQL code, no explanations.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
    });

    const sql = completion.choices[0].message.content.trim();
    console.log("🧠 SQL Generated:\n", sql);

    if (!sql.toLowerCase().startsWith("select"))
      throw new Error("Only SELECT queries are allowed");

    const { data, error } = await supabase.rpc("exec_sql", { sql });
    if (error) throw error;

    // skip chart generation on vercel
    let chartBase64 = null;
    try {
      if (!process.env.VERCEL) {
        console.log("⚙️ Chart generation allowed locally");
        const { ChartJSNodeCanvas } = await import("chartjs-node-canvas");
        const chartJSNodeCanvas = new ChartJSNodeCanvas({ width: 800, height: 400 });
        const chartBuffer = await chartJSNodeCanvas.renderToBuffer({
          type: "bar",
          data: {
            labels: data.map((row, i) => row.Party_Name || `Row ${i + 1}`),
            datasets: [{ label: "Qty", data: data.map((row) => row.Qty || 0) }],
          },
        });
        chartBase64 = chartBuffer.toString("base64");
      } else {
        console.log("⛔ Chart skipped on Vercel (read-only fs)");
      }
    } catch (e) {
      console.warn("Chart generation skipped:", e.message);
    }

    const summary = `Fetched ${data?.length || 0} rows.`;
    res.json({ summary, sql, table: data, chart: chartBase64 });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
