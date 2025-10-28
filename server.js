import express from "express";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const app = express();
app.use(express.json());

// 🔗 Supabase connection
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🧠 OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ⚙️ Function to fetch *live* schema from Supabase
async function getLiveSchema() {
  console.log("🔍 Fetching latest schema...");
  const { data, error } = await supabase.rpc("get_schema_structure");
  if (error) {
    console.error("⚠️ Schema fetch error:", error.message);
    throw error;
  }
  console.log("✅ Schema fetched:", data?.length || 0, "tables");
  return data;
}

// 🧩 POST endpoint
app.post("/ai/query", async (req, res) => {
  const { question } = req.body;

  try {
    // fetch the most current schema
    const schema = await getLiveSchema();

    const systemPrompt = `
You are an AI expert in writing PostgreSQL queries.

⚠️ Rules:
1. Always wrap table and column names containing uppercase letters or underscores in double quotes ("").
2. Only generate SELECT statements — never modify data.
3. Use the live schema below to construct accurate queries.
4. Never invent table or column names.

Schema:
${JSON.stringify(schema, null, 2)}

User question: "${question}"

Return only valid SQL code.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }],
    });

    const sql = completion.choices[0].message.content.trim();

    res.json({
      summary: `Generated query for: ${question}`,
      sql,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🟢 Start the server
app.listen(process.env.PORT || 4000, () =>
  console.log(`✅ Business Bot API running on port ${process.env.PORT || 4000}`)
);
