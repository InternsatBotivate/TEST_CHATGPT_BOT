import fs from "fs";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

export async function refreshSchema() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // You can replace this RPC if your schema function name differs
  const { data, error } = await supabase.rpc("get_schema");
  if (error) throw error;

  fs.writeFileSync("./schema.json", JSON.stringify(data, null, 2));
  console.log(`✅ schema.json updated with ${data.length} columns`);
  return data;
}
