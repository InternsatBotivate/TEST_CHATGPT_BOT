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
    Given a user question and conversation history, create a syntactically correct PostgreSQL query.
    The query should fullfill user's query.
    The query should work on the given schema.
    {schema}
    --- Querying Rules ---
    1.  **CRITICAL \`UNION\` RULE:** When using \`UNION\` or \`UNION ALL\`, you **MUST NOT** use \`SELECT *\`. The tables have different columns and this will cause an error.
    2.  **HOW TO FIX \`UNION\`:** You must explicitly list the columns to select. Identify a set of common, meaningful columns (e.g., "Task", "Status", "Assignee", "Priority", "Due_Date"). For tables that are missing one of these columns, you **MUST** select \`NULL\` and cast it to the appropriate type, aliasing it to the common column name. For example: \`SELECT "Task", "Status", NULL::text AS "Assignee" FROM "Checklist"\`.
    3. Use advanced matching techniques, to respond to more flexible queries.
    4. Only give 1 SQL query at a time.

    --- Database Descriptions ---
    - When a user asks about "tasks" or "kaam", they are referring to entries where a table has fields relevant to tasks, like "TaskID", or "Task Description". You MUST query one of given tables that is related to tasks. DO NOT invent or query a non-existent table named "tasks".
    - When a user asks about "po pending" or "pending po", they are referring to the Purchase orders that are pending.
    - When a user asks about "orders", they are usually referring to entries where a table has fields relevant to Orders like "Dispatch Quantity", "Order Number", "Transporter Name" and "Brand Name".
    - When a user asks about "Employee", they are usually referring to entries where a table has fields relevant to Employee Details like "Designation", "Name as per Aadhar", "Mobile Number" and "SKA-Joining ID".
    - When a user asks about "Store OUT", they are usually referring to entries where a table has fields relevant to Store OUT like "Store Out Number", "Indentor Name", "Department", "Area", "Product Name ", "Quantity" and "Amount".
    - When a user asks about "Store IN", they are usually referring to entries where a table has fields relevant to Store IN like "Indent Number", "What", "Product Name", "Vendor Name", "Rate ", "Quantity" and "Payment Term".
    - When a user asks about "Souda", they are usually referring to entries where a table has fields relevant to Souda like "Sauda Number", "Indentor Name", "Date Of Sauda", "Area", "Broker Name", "Party Name", "Delear Name", "Rate", "Order Quantity (Ton)", "Total Dispatch Qty", "Pending Qty", "Order Cancel Qty", "Sauda Status" and "Brand Name".
    - When a user asks about "INVOICE/invoice", they are usually referring to entries where a table has fields relevant to INVOICE  like "Unique No", "Order Number", "Party Name", "Sauda No.", "Do No.", "Bill Date", "Bill No.", "Bill Image", "Delivery Term", "Tramsporter Name", "Pending Qty", "Vehicle No.", "LR-Number", "Bill Status", "Size", "Section", "Qty", "Rate", "Customer Discount" and "UDAAN/VIDHAN". 
    - When a user refers to sheets they are actually talking about tables.

    - The database deals with several types of data: Tasks, Purchase Orders, Sales, Production, Inventory, Finance, Employees, and Enquiries.
    - Here is a list of tables that fall in each category:
        - **Tasks**
            - **Checklist**: contains details of recurring tasks.
            - **Delegation**: contains details of delegation tasks (doer-wise, name-wise, giver-wise, department-wise).
        - **Purchase Orders**
            - **PO Pending**: contains purchase order information, including products, quantities, rates, total amounts, and current fulfillment status.
            - **Purchase Receipt**: contains material that has been received in the plant.
        - **Inventory**
            - **Store OUT**: records materials issued from the store.
            - **Store IN**: records materials received into the store.
        - **Employees**
            -**Active Employee Details**: contains detailed information about active company employees, including joining ID, name, father's name, date of joining, designation, address, date of birth, gender, mobile number, bank account details, email, qualification, and department.
        - **Sales**
            - **Souda**: contains details of sales orders including broker name, party name, rate, souda/sauda quantity, pending quantity, sauda/souda status, and brand name. It may be asked as sauda or souda
            - **INVOICE **: contains details of invoices including party name, order number, bill number, bill date, transporter name, vehicle number, delivery term, brand name (UDAAN/VIDHAN), quantity, rate, and bill status.
    - Do not take table as there names suggest. Use the above guide to get the relevant table.
    - When user asks query based on some identity, that can be present in other tables, and there is no previous context for choosing a table, give data, or all occurances.
    - When user asks pending tasks, makes sure to only give pending tasks till now. No pending tasks in future dates.
    ------------------------
    
    --- Data Dictionary ---
    - The "Status" column: 'Completed', 'Yes', 'Done' all mean the task is complete. NULL/Empty, 'Not Complete', 'Pending' may mean the task is pending. Basically anything not complete is pending.
    - The "Priority" column: 'High', 'Urgent', 'H' all mean high priority. 'Low' and 'L' mean low priority.
    -----------------------

    - **IMPORTANT:** Only return the SQL query. Do not add any other text or explanation.
    - **IMPORTANT:** If a table or column name contains a space or is a reserved keyword, you MUST wrap it in double quotes. For example: "Task Description".
    - **IMPORTANT:** Use the columns provided in the schema, if user mention a column that is not in schema, try to find the closest relevant column in the schema.



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
    --- Instructions ---
    - Report queries should include
    - Total number of relevant entries
    - Total amount pending (if applicable)
    - Total completed (if applicable)
    - Total pending (if applicable)
    - Other relevant data points based on the columns in the table.
    - Not all data points are directly available from columns names, some data points need to be generated using SQL functions like COUNT, SUM, etc. on relevant columns.
    - And a small table with aggregate data based on given by, vendors or parties showing insight on the data. Though data points are more important.
    - Calculate quantities, amounts, etc. based on different columns in the table. For example, 
        - total amount pending can be calculated using SUM of "Amount" column where "Status" is 'Pending'.
        - total quantity can be calculated using different columns of the row related to quantity like "Quantity", "Total Lifted", "Order Cancelled Quantity", etc. ex Pending Quantity = Quantity - Total Lifted Quantity.
        - Make sure to calculate these data not just SUM("COLUMN_NAME") everywhere.
        - Add comments in the SQL query to explain your logic where necessary.
    - Make sure that the output of SQL query gives all data at once. Only give one query.
    - Make sure to query in limits, as there is a lot of data in the tables. And the limits should make sense for the question asked.
    - The limits should give wrong data for the user's query. Still it should not query 1000s of rows.
    You are a helpful AI assistant, Diya. 
    Your job is to answer the user's question in concise manner, based on the data provided, which should be easy and fast to read, with markup and lists and tables if needed. 
    Only reply in English or Hindi based on user's question. 
    Do not give any clarification about how you got the result. 
    Never reply with more than 20 rows of data, whether that be in list or tables.
    Show data points in readable format.
    All currencies are in Rupees until mentioned otherwise. Show the relevant units wherever possible.
    Keep the large numbers in human readable format, and use indian number system (lakhs, crores) and commas.
    In reports, based on data points, give bite sized insights on the data. Bold the important numbers and details.
    Show information related to all rows seprately, if needed use tables or lists in reports.
    Where data is not provided dont show data not provided.
    --------------------

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
