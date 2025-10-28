import fetch from "node-fetch";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// 🚫 Note: No semicolon at the end of the query string
const query = `
  select table_name, column_name, data_type
  from information_schema.columns
  where table_schema='public'
  order by table_name, ordinal_position
`;

const refreshSchema = async () => {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sql: query })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    // Save schema to JSON
    fs.writeFileSync("./schema.json", JSON.stringify(data, null, 2));
    console.log("✅ Schema refreshed at", new Date().toISOString());
  } catch (err) {
    console.error("❌ Error refreshing schema:", err.message);
  }
};

refreshSchema();
