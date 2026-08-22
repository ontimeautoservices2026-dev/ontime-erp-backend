const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
// --- Multer (File Upload) Setup ---
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ပုံသိမ်းရန် uploads ဖိုင်တွဲ မရှိပါက အသစ်တည်ဆောက်မည်
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// 🌐 Frontend မှ ပုံများကို လှမ်းယူနိုင်ရန် Public Folder အဖြစ် ဖွင့်ပေးခြင်း
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });
const port = process.env.PORT || 5000;
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Middleware
app.use(cors({
  origin: '*', // နေရာတိုင်း (Browser ရော၊ EXE ရော၊ Mobile ရော) ကနေ လှမ်းခေါ်ခွင့်ပြုမည်
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// PostgreSQL Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test Connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Database connection error ❌', err.stack);
  }
  console.log('PostgreSQL Database Connected Successfully ✅');
  release();
});

// ==========================================
// 🚀 1. CREATE INVOICE API (ဘောင်ချာအသစ်သိမ်းရန်)
// ==========================================
app.post('/api/invoices', async (req, res) => {
  const client = await pool.connect(); // Database ချိတ်ဆက်မှု စတင်ပါမည်
  
  try {
    // 🌟 Transaction စပါပြီ (အမှားတစ်ခုခုဖြစ်ရင် Data တွေ အကုန်ပြန်ရုပ်သိမ်းပေးမယ့် စနစ်ပါ)
    await client.query('BEGIN');

    // Frontend (React) ကနေ ပို့လိုက်မယ့် Data တွေကို လက်ခံယူပါမယ်
    const { customer, vehicle, invoice, items } = req.body;

    // ၁။ Customers Table ထဲ Data ထည့်မည် (ထည့်ပြီးသွားတဲ့ Customer ရဲ့ ID ကို ပြန်တောင်းယူမည်)
    const customerRes = await client.query(
      `INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`,
      [customer.name, customer.phone]
    );
    const customerId = customerRes.rows[0].id;

    // ၂။ Vehicles Table ထဲ Data ထည့်မည် (Customer ID နဲ့ ချိတ်ဆက်ပြီး)
    await client.query(
      `INSERT INTO vehicles (customer_id, model, license_plate) VALUES ($1, $2, $3)`,
      [customerId, vehicle.model, vehicle.plate]
    );

    // ၃။ Invoices Table ထဲ Data ထည့်မည် (Customer ID နဲ့ ချိတ်ဆက်ပြီး)
    const invoiceRes = await client.query(
      `INSERT INTO invoices (customer_id, inv_no, issue_date, sub_total, discount_type, discount_value, tax, grand_total, payment_method, payment_status, cash_received, change_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        customerId, invoice.invNo, invoice.date, invoice.subTotal, 
        invoice.discountType, invoice.discountValue, invoice.tax, 
        invoice.grandTotal, invoice.paymentMethod, invoice.paymentStatus, 
        invoice.cashReceived, invoice.changeAmount
      ]
    );
    const invoiceId = invoiceRes.rows[0].id;

    // ၄။ Invoice Items Table ထဲ Data တွေ အများကြီးဖြစ်လို့ ပတ်ပြီး (Loop) ထည့်မည်
    for (let item of items) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, description, qty, unit_price, total_amount) VALUES ($1, $2, $3, $4, $5)`,
        [invoiceId, item.desc, item.qty, item.price, item.total]
      );
    }

    // 🌟 အကုန်လုံး အောင်မြင်သွားရင် Database ထဲ အတည်ပြု သိမ်းလိုက်ပါပြီ
    await client.query('COMMIT');
    
    // Frontend ကို အောင်မြင်ကြောင်း ပြန်ပြောမည်
    res.status(201).json({ success: true, message: 'Invoice saved successfully!', invoiceId: invoiceId });

  } catch (error) {
    // ❌ Error တစ်ခုခုတက်ရင် ထည့်လက်စ Data တွေ အကုန်ပြန်ရုပ်သိမ်းမည် (ROLLBACK)
    await client.query('ROLLBACK');
    console.error('Error saving invoice ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to save invoice', error: error.message });
  } finally {
    // ချိတ်ဆက်မှုကို ပြန်လွှတ်ပေးပါမည်
    client.release();
  }
});


// ==========================================
// 🚀 2. GET ALL INVOICES API (ဘောင်ချာစာရင်း ပြန်ခေါ်ရန်)
// ==========================================
app.get('/api/invoices', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.inv_no, c.name as customer_name, i.grand_total, i.payment_status, i.issue_date
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      ORDER BY i.created_at DESC
    `);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching invoices ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch invoices' });
  }
});


// Server Start
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});


// ==========================================
// 🚀 3. ACCOUNTING APIs (ငွေစာရင်းပိုင်းအတွက်)
// ==========================================

// (က) ငွေစာရင်း (Ledger) များကို ပြန်ခေါ်ရန် (GET)
app.get('/api/accounting/ledger', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounting_ledger ORDER BY created_at ASC');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching ledger ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch ledger' });
  }
});

// (ခ) အသုံးစရိတ် (သို့) ငွေစာရင်းအသစ် ထည့်သွင်းရန် (POST)
app.post('/api/accounting/ledger', async (req, res) => {
  try {
    const { id, date, ref, desc, category, method, type, amount, cogs } = req.body;
    
    await pool.query(
      `INSERT INTO accounting_ledger (trx_id, trx_date, ref_no, description, category, method, type, amount, cogs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, date, ref, desc, category, method, type, amount, cogs]
    );
    res.status(201).json({ success: true, message: 'Ledger entry saved!' });
  } catch (error) {
    console.error('Error saving ledger ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to save ledger' });
  }
});

// (ဂ) လစဉ် အဖွင့်လက်ကျန်များကို ပြန်ခေါ်ရန် (GET)
app.get('/api/accounting/openings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM monthly_openings');
    // React ဖတ်လို့လွယ်အောင် Object ပုံစံ ပြောင်းပေးမည်
    const openingsObj = {};
    result.rows.forEach(row => {
      openingsObj[row.period_month] = Number(row.amount);
    });
    res.status(200).json(openingsObj);
  } catch (error) {
    console.error('Error fetching openings ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch openings' });
  }
});

// (ဃ) လစဉ် အဖွင့်လက်ကျန် အသစ်ပြင်ဆင်/ထည့်သွင်းရန် (POST)
app.post('/api/accounting/openings', async (req, res) => {
  try {
    const { period_month, amount } = req.body;
    // ON CONFLICT သုံးထားတဲ့အတွက် ရှိပြီးသားလဆိုရင် Update လုပ်ပြီး၊ မရှိသေးရင် အသစ်ထည့်ပေးပါမည်
    await pool.query(
      `INSERT INTO monthly_openings (period_month, amount) 
       VALUES ($1, $2)
       ON CONFLICT (period_month) DO UPDATE SET amount = EXCLUDED.amount`,
      [period_month, amount]
    );
    res.status(200).json({ success: true, message: 'Opening balance updated!' });
  } catch (error) {
    console.error('Error saving opening balance ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to update opening balance' });
  }
});

// (င) ငွေစာရင်း မှတ်တမ်း ဖျက်ရန် (DELETE)
app.delete('/api/accounting/ledger/:id', async (req, res) => {
  try {
    // Frontend က ပို့လိုက်တဲ့ ID ကို သုံးပြီး ဖျက်ပါမည် (trx_id ဖြင့် ရှာပါသည်)
    await pool.query('DELETE FROM accounting_ledger WHERE trx_id = $1', [req.params.id]);
    res.status(200).json({ success: true, message: 'Ledger entry deleted successfully!' });
  } catch (error) {
    console.error('Error deleting ledger ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to delete ledger entry' });
  }
});

// ==========================================
// 🚀 4. CUSTOMERS APIs (ဖောက်သည်စာရင်းအတွက်)
// ==========================================

// (က) ဖောက်သည်စာရင်းအားလုံး ပြန်ခေါ်ရန် (GET)
// ကားအမည် နဲ့ ဘောင်ချာကနေ စုစုပေါင်း သုံးစွဲခဲ့တဲ့ ငွေပမာဏ (Total Spent) ကိုပါ တစ်ခါတည်း တွက်ထုတ်ပေးပါမည်
app.get('/api/customers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id, 
        c.name, 
        c.phone, 
        v.model as vehicle,
        COALESCE(SUM(i.grand_total), 0) as spent
      FROM customers c
      LEFT JOIN vehicles v ON c.id = v.customer_id
      LEFT JOIN invoices i ON c.id = i.customer_id
      GROUP BY c.id, c.name, c.phone, v.model
      ORDER BY c.id DESC
    `);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching customers ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch customers' });
  }
});

// (ခ) ဖောက်သည်အသစ် ထည့်သွင်းရန် (POST)
app.post('/api/customers', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, phone, vehicle } = req.body;

    // ၁။ Customers ဇယားထဲ အရင်ထည့်မည်
    const cusRes = await client.query(
      'INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id',
      [name, phone]
    );
    const newCustomerId = cusRes.rows[0].id;

    // ၂။ Vehicles ဇယားထဲ ဆက်ထည့်မည် (License Plate မပါသေးပါက N/A အနေဖြင့် ယာယီသိမ်းမည်)
    await client.query(
      'INSERT INTO vehicles (customer_id, model, license_plate) VALUES ($1, $2, $3)',
      [newCustomerId, vehicle || 'N/A', 'N/A']
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Customer added!' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding customer ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to add customer' });
  } finally {
    client.release();
  }
});

// (ဂ) ဖောက်သည်အချက်အလက် ပြင်ဆင်ရန် (PUT)
app.put('/api/customers/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { name, phone, vehicle } = req.body;

    await client.query('UPDATE customers SET name = $1, phone = $2 WHERE id = $3', [name, phone, id]);
    // ကားအမည်ကိုပါ Update လုပ်မည်
    await client.query('UPDATE vehicles SET model = $1 WHERE customer_id = $2', [vehicle, id]);

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Customer updated!' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating customer ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to update customer' });
  } finally {
    client.release();
  }
});

// (ဃ) ဖောက်သည်မှတ်တမ်း ဖျက်ရန် (DELETE)
app.delete('/api/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Database တွင် ON DELETE CASCADE လုပ်ထားသောကြောင့် Customer ဖျက်လိုက်သည်နှင့် သူ၏ ကားမှတ်တမ်းပါ အလိုအလျောက် ပျက်သွားပါမည်
    await pool.query('DELETE FROM customers WHERE id = $1', [id]);
    res.status(200).json({ success: true, message: 'Customer deleted!' });
  } catch (error) {
    console.error('Error deleting customer ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to delete customer' });
  }
});

// ==========================================
// 🚀 5. DASHBOARD APIs (ဒက်ရှ်ဘုတ် စာရင်းချုပ်အတွက်)
// ==========================================

app.get('/api/dashboard', async (req, res) => {
  try {
    // ၁။ စုစုပေါင်း Job Card အရေအတွက် (Total Jobs)
    const totalJobsRes = await pool.query('SELECT COUNT(*) as count FROM invoices');
    const totalJobs = parseInt(totalJobsRes.rows[0].count) || 0;

    // ၂။ ယနေ့ဝင်ငွေ (Today's Revenue)
    // Local Time အတိုင်း ယနေ့ရက်စွဲကို ယူပါမည်
    const todayStr = new Date().toISOString().split('T')[0]; 
    const todayRevRes = await pool.query('SELECT SUM(grand_total) as total FROM invoices WHERE issue_date = $1', [todayStr]);
    const todayRevenue = parseFloat(todayRevRes.rows[0].total) || 0;

    // ၃။ ရရန်ကျန်ငွေ (Outstanding Amount - Unpaid သို့မဟုတ် Partial ဖြစ်နေသော ဘောင်ချာများမှ)
    const outRes = await pool.query("SELECT SUM(grand_total - cash_received) as total FROM invoices WHERE payment_status IN ('Unpaid', 'Partial')");
    const outstanding = parseFloat(outRes.rows[0].total) || 0;

    // ၄။ အလုပ်အခြေအနေများ (လက်ရှိ ဇယားတွင် Status မပါသေးသဖြင့် နမူနာ တွက်ချက်ပြထားခြင်းဖြစ်ပါသည်)
    // နောင်တွင် Invoices ဇယားတွင် job_status column ထပ်ထည့်၍ ပြင်နိုင်ပါသည်။
    const completedJobs = Math.floor(totalJobs * 0.6); 
    const inProgressJobs = Math.floor(totalJobs * 0.3);
    const waitingPartsJobs = totalJobs - completedJobs - inProgressJobs;

    // ၅။ ယနေ့ အချိန်ဇယား (Schedule - နောက်ဆုံး ဝင်ထားသော ကား ၄ စီးကို ဆွဲယူမည်)
    const scheduleRes = await pool.query(`
      SELECT v.model, i.created_at
      FROM invoices i
      JOIN vehicles v ON i.customer_id = v.customer_id
      ORDER BY i.created_at DESC
      LIMIT 4
    `);

    res.status(200).json({
      success: true,
      data: {
        totalJobs,
        inProgressJobs,
        waitingPartsJobs,
        completedJobs,
        todayRevenue,
        outstanding,
        schedule: scheduleRes.rows
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard data ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard data' });
  }
});

// ==========================================
// 🚀 6. EMPLOYEES & PAYROLL APIs (ဝန်ထမ်းနှင့် လစာငွေအတွက်)
// ==========================================

// (က) ဝန်ထမ်းစာရင်းများ ပြန်ခေါ်ရန် (GET)
app.get('/api/employees', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employees ORDER BY id DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching employees ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch employees' });
  }
});

// (ခ) ဝန်ထမ်းအသစ် ထည့်သွင်းရန် (POST)
app.post('/api/employees', async (req, res) => {
  try {
    const { emp_id, name, nrc, phone, role, shift, joinDate, salary, commission, bonus, allowedLeaves } = req.body;
    await pool.query(
      `INSERT INTO employees (emp_id, name, nrc, phone, role, shift, join_date, salary, commission, bonus, allowed_leaves)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [emp_id, name, nrc, phone, role, shift, joinDate, salary, commission, bonus, allowedLeaves]
    );
    res.status(201).json({ success: true, message: 'Employee added successfully!' });
  } catch (error) {
    console.error('Error adding employee ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to add employee' });
  }
});

// (ဂ) ဝန်ထမ်းအချက်အလက် ပြင်ဆင်ရန် (PUT)
app.put('/api/employees/:id', async (req, res) => {
  try {
    const { name, nrc, phone, role, shift, joinDate, salary, commission, bonus, allowedLeaves } = req.body;
    await pool.query(
      `UPDATE employees 
       SET name=$1, nrc=$2, phone=$3, role=$4, shift=$5, join_date=$6, salary=$7, commission=$8, bonus=$9, allowed_leaves=$10 
       WHERE id=$11`,
      [name, nrc, phone, role, shift, joinDate, salary, commission, bonus, allowedLeaves, req.params.id]
    );
    res.status(200).json({ success: true, message: 'Employee updated!' });
  } catch (error) {
    console.error('Error updating employee ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to update employee' });
  }
});

// (ဃ) ပျက်ရက် (Absent Days) ကို သီးသန့် Update လုပ်ရန် (PATCH)
app.patch('/api/employees/:id/absent', async (req, res) => {
  try {
    const { absentDays } = req.body;
    await pool.query('UPDATE employees SET absent_days = $1 WHERE id = $2', [absentDays, req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (င) ဝန်ထမ်းမှတ်တမ်း ဖျက်ရန် (DELETE)
app.delete('/api/employees/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true, message: 'Employee deleted!' });
  } catch (error) {
    console.error('Error deleting employee ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to delete employee' });
  }
});

// (စ) 🌟 လစာပေးချေခြင်း (Payroll) နှင့် Accounting Ledger သို့ Auto-Sync ချိတ်ဆက်ခြင်း
app.post('/api/employees/payroll', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Transaction စတင်မည်
    
    const { emp_id, db_id, name, role, netPay, absentDays } = req.body;

    // ၁။ ဝန်ထမ်းကို လစာပေးပြီးကြောင်း 'Paid' ပြောင်းမည်၊ ပျက်ရက်ကိုပါ တစ်ခါတည်း Update လုပ်မည်
    await client.query(
      "UPDATE employees SET pay_status = 'Paid', absent_days = $1 WHERE id = $2", 
      [absentDays, db_id]
    );

    // ၂။ Accounting Ledger ထဲသို့ အသုံးစရိတ် (Expense - OUT) အဖြစ် သွားထည့်မည်
    const trxId = `PAY-${Date.now().toString().slice(-6)}`;
    const dateStr = new Date().toLocaleDateString('en-GB'); // Format: DD/MM/YYYY
    await client.query(
      `INSERT INTO accounting_ledger (trx_id, trx_date, ref_no, description, category, method, type, amount, cogs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [trxId, dateStr, emp_id, `Payroll - ${name} (${role})`, 'Payroll', 'CASH', 'OUT', netPay, 0]
    );

    await client.query('COMMIT'); // အားလုံးအောင်မြင်ပါက Save မည်
    res.status(200).json({ success: true, message: 'Payroll processed and synced to accounting!' });
  } catch (error) {
    await client.query('ROLLBACK'); // Error တက်ပါက အကုန်ပြန်ရုပ်သိမ်းမည်
    console.error('Error processing payroll ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to process payroll' });
  } finally {
    client.release();
  }
});

// ==========================================
// 🚀 7. VEHICLE INSPECTIONS APIs (ကားစစ်ဆေးမှု မှတ်တမ်းအတွက်)
// ==========================================

// (က) စစ်ဆေးမှု မှတ်တမ်းများ ပြန်ခေါ်ရန် (GET)
app.get('/api/inspections', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vehicle_inspections ORDER BY id DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching inspections ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inspections' });
  }
});

// (ခ) စစ်ဆေးမှု မှတ်တမ်းအသစ် သိမ်းဆည်းရန် (POST)
app.post('/api/inspections', async (req, res) => {
  try {
    const { inspection_id, date, vehicle, vin, status, data } = req.body;
    
    await pool.query(
      `INSERT INTO vehicle_inspections (inspection_id, inspection_date, vehicle, vin, status, checklist_data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [inspection_id, date, vehicle, vin, status, JSON.stringify(data)]
    );
    
    res.status(201).json({ success: true, message: 'Inspection record saved successfully!' });
  } catch (error) {
    console.error('Error saving inspection ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to save inspection' });
  }
});

// (ဂ) စစ်ဆေးမှု မှတ်တမ်း ဖျက်ရန် (DELETE)
app.delete('/api/inspections/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM vehicle_inspections WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true, message: 'Inspection deleted successfully!' });
  } catch (error) {
    console.error('Error deleting inspection ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to delete inspection' });
  }
});

// ==========================================
// 🚀 8. INVENTORY APIs (ပစ္စည်းလက်ကျန် စာရင်းအတွက်)
// ==========================================

// (က) ပစ္စည်းစာရင်းအားလုံး ပြန်ခေါ်ရန် (GET)
app.get('/api/inventory', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory ORDER BY id DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching inventory ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inventory' });
  }
});

// (ခ) ပစ္စည်းအသစ် ထည့်သွင်းရန် (POST)
app.post('/api/inventory', async (req, res) => {
  try {
    const { sku, name, category, stock, costPrice, price } = req.body;
    await pool.query(
      `INSERT INTO inventory (sku, name, category, stock, cost_price, price)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sku, name, category, stock, costPrice, price]
    );
    res.status(201).json({ success: true, message: 'Part added to inventory!' });
  } catch (error) {
    console.error('Error adding part ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to add part' });
  }
});

// (ဂ) ပစ္စည်းအချက်အလက် (သို့) အရေအတွက် ပြင်ဆင်ရန် (PUT)
app.put('/api/inventory/:id', async (req, res) => {
  try {
    const { name, category, stock, costPrice, price } = req.body;
    await pool.query(
      `UPDATE inventory 
       SET name = $1, category = $2, stock = $3, cost_price = $4, price = $5 
       WHERE id = $6`,
      [name, category, stock, costPrice, price, req.params.id]
    );
    res.status(200).json({ success: true, message: 'Part updated!' });
  } catch (error) {
    console.error('Error updating part ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to update part' });
  }
});

// (ဃ) ပစ္စည်းမှတ်တမ်း ဖျက်ရန် (DELETE)
app.delete('/api/inventory/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM inventory WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true, message: 'Part deleted!' });
  } catch (error) {
    console.error('Error deleting part ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to delete part' });
  }
});

// ==========================================
// 🚀 9. JOB CARDS APIs (အလုပ်မှတ်တမ်းကတ်များအတွက်)
// ==========================================

// (က) Job Card အားလုံး ပြန်ခေါ်ရန် (GET)
app.get('/api/jobcards', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM job_cards ORDER BY id DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching job cards ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch job cards' });
  }
});

// (ခ) Job Card အသစ် ဖွင့်ရန် (POST)
app.post('/api/jobcards', async (req, res) => {
  try {
    const { job_id, task, car, customer, tech, progress, status } = req.body;
    await pool.query(
      `INSERT INTO job_cards (job_id, task, car, customer, tech, progress, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [job_id, task, car, customer, tech, progress, status]
    );
    res.status(201).json({ success: true, message: 'Job card created successfully!' });
  } catch (error) {
    console.error('Error creating job card ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to create job card' });
  }
});

// (ဂ) Job Card Status နှင့် Progress အား ပြင်ဆင်ရန် (PUT)
app.put('/api/jobcards/:id', async (req, res) => {
  try {
    const { tech, progress, status } = req.body;
    await pool.query(
      `UPDATE job_cards SET tech = $1, progress = $2, status = $3 WHERE id = $4`,
      [tech, progress, status, req.params.id]
    );
    res.status(200).json({ success: true, message: 'Job card updated!' });
  } catch (error) {
    console.error('Error updating job card ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to update job card' });
  }
});

// (ဃ) Job Card ဖျက်ရန် (DELETE)
app.delete('/api/jobcards/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM job_cards WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true, message: 'Job card deleted!' });
  } catch (error) {
    console.error('Error deleting job card ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to delete job card' });
  }
});

// ==========================================
// 🚀 10. SALES & INVOICES APIs (အရောင်းဘောင်ချာများအတွက်)
// ==========================================

// (က) ဘောင်ချာစာရင်းများ ပြန်ခေါ်ရန် (GET)
app.get('/api/sales', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sales_invoices ORDER BY id DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching sales ❌:', error);
    res.status(500).json({ success: false });
  }
});

// (ခ) ဘောင်ချာအသစ် ဖွင့်ရန် (POST) - Inventory နှင့် Accounting အား Auto Update လုပ်ပါမည်
app.post('/api/sales', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Transaction စမည်
    const { inv, cus, phone, cars, billItems, date, total, status, alert } = req.body;

    // ၁။ Sales Invoice ဇယားထဲ အရင်သိမ်းမည်
    await client.query(
      `INSERT INTO sales_invoices (inv_no, customer_name, phone, issue_date, total_amount, status, alert, cars, bill_items)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [inv, cus, phone, date, total, status, alert, JSON.stringify(cars), JSON.stringify(billItems)]
    );

    // ၂။ Accounting Ledger ထဲသို့ ဝင်ငွေ (Revenue) အဖြစ် သွားပေါင်းမည်
    const numTotal = Number(total.replace(/,/g, ''));
    let cogs = 0; // ပစ္စည်းအရင်း (Cost of Goods Sold) ကို တွက်မည်
    billItems.parts.forEach(p => {
        const cost = p.costPrice ? Number(String(p.costPrice).replace(/,/g, '')) : (Number(String(p.price).replace(/,/g, '')) * 0.6);
        cogs += cost * p.qty;
    });

    const trxId = `TRX-${Date.now().toString().slice(-6)}`;
    await client.query(
      `INSERT INTO accounting_ledger (trx_id, trx_date, ref_no, description, category, method, type, amount, cogs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [trxId, date, inv, `Invoice Payment (${cus})`, 'Revenue', 'CASH', 'IN', numTotal, cogs]
    );

    // ၃။ Inventory (ဂိုဒေါင်) ထဲကနေ ရောင်းလိုက်ရတဲ့ ပစ္စည်းအရေအတွက်ကို သွားနှုတ်မည်
    for (let part of billItems.parts) {
        if (part.sku) {
            await client.query('UPDATE inventory SET stock = stock - $1 WHERE sku = $2', [part.qty, part.sku]);
        }
    }

    await client.query('COMMIT'); // အားလုံးအောင်မြင်ပါက အတည်ပြုမည်
    res.status(201).json({ success: true, message: 'Invoice created successfully!' });
  } catch (error) {
    await client.query('ROLLBACK'); // Error တက်ပါက ပြန်ရုပ်သိမ်းမည်
    console.error('Error creating invoice ❌:', error);
    res.status(500).json({ success: false });
  } finally {
    client.release();
  }
});

// (င) ဘောင်ချာ နံပါတ် (ID) ဖြင့် ဘောင်ချာတစ်စောင်တည်းကို အတိအကျ ပြန်ခေါ်ရန် (GET Single Invoice)
app.get('/api/sales/:inv_no', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sales_invoices WHERE inv_no = $1', [req.params.inv_no]);
    if (result.rows.length > 0) {
      res.status(200).json(result.rows[0]);
    } else {
      res.status(404).json({ success: false, message: 'Invoice not found' });
    }
  } catch (error) {
    console.error('Error fetching single invoice ❌:', error);
    res.status(500).json({ success: false });
  }
});

// (ဂ) ဘောင်ချာ Status (Paid/Unpaid) ပြင်ရန် (PUT)
app.put('/api/sales/:inv_no/status', async (req, res) => {
  try {
    const { status, alert } = req.body;
    await pool.query('UPDATE sales_invoices SET status = $1, alert = $2 WHERE inv_no = $3', [status, alert, req.params.inv_no]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ဃ) ဘောင်ချာ ဖျက်ရန် (DELETE)
app.delete('/api/sales/:inv_no', async (req, res) => {
  try {
    await pool.query('DELETE FROM sales_invoices WHERE inv_no = $1', [req.params.inv_no]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// 🚀 11. SETTINGS & USERS APIs (စနစ် ဆက်တင်များနှင့် သုံးစွဲသူများအတွက်)
// ==========================================

// (က) Workshop Settings ရယူရန်
app.get('/api/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM workshop_settings WHERE id = 1');
    res.status(200).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ခ) Workshop Settings ပြင်ဆင်ရန်
app.put('/api/settings', async (req, res) => {
  try {
    const { workshop_name, currency, address, phone, master_email, master_password } = req.body;
    
    // Password အသစ်ရိုက်ထည့်ထားရင် Password ကိုပါ Update လုပ်မည်
    if (master_password) {
        await pool.query(
          `UPDATE workshop_settings SET workshop_name=$1, currency=$2, address=$3, phone=$4, master_email=$5, master_password=$6 WHERE id=1`,
          [workshop_name, currency, address, phone, master_email, master_password]
        );
    } else {
        await pool.query(
          `UPDATE workshop_settings SET workshop_name=$1, currency=$2, address=$3, phone=$4, master_email=$5 WHERE id=1`,
          [workshop_name, currency, address, phone, master_email]
        );
    }
    res.status(200).json({ success: true, message: 'Settings updated!' });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ဂ) Users (Sub-accounts) စာရင်း ရယူရန်
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, role, status FROM users ORDER BY id DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ဃ) User Account အသစ် ဖန်တီးရန် (Password ပါ တစ်ပါတည်း သိမ်းမည်)
app.post('/api/users', async (req, res) => {
  try {
    // Frontend က ပို့လိုက်မယ့် Data ထဲကနေ password ကိုပါ ဆွဲထုတ်လိုက်ပါပြီ
    const { name, email, role, password } = req.body;
    
    await pool.query(
      `INSERT INTO users (name, email, role, password) VALUES ($1, $2, $3, $4)`,
      [name, email, role, password || '123456'] // <--- ဒီမှာ password ပါ ထည့်သွင်းခိုင်းလိုက်ပါပြီ (ဘာမှမပါလာရင် Default '123456' ယူပေးပါမည်)
    );
    res.status(201).json({ success: true, message: 'User created successfully!' });
  } catch (error) {
    console.error('Error creating user ❌:', error);
    res.status(500).json({ success: false });
  }
});

// (င) User Account ဖျက်ရန်
app.delete('/api/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (စ) User Password ပြောင်းရန် (Change Password API အသစ်ထည့်ပေးထားပါသည်)
app.put('/api/users/:id/password', async (req, res) => {
  try {
    const { newPassword } = req.body;
    await pool.query(
      'UPDATE users SET password = $1 WHERE id = $2', 
      [newPassword, req.params.id]
    );
    res.status(200).json({ success: true, message: 'Password updated successfully!' });
  } catch (error) {
    console.error('Error updating password ❌:', error);
    res.status(500).json({ success: false, message: 'Failed to update password' });
  }
});

// ==========================================
// 🚀 12. VEHICLES APIs (ကားအချက်အလက် မှတ်တမ်းများအတွက်)
// ==========================================

// (က) ကားမှတ်တမ်းအားလုံး ပြန်ခေါ်ရန် (GET)
// ဒီနေရာမှာ ကားပိုင်ရှင်နာမည်ကို သိနိုင်ဖို့ customers ဇယားနဲ့ JOIN လုပ်ထားပါတယ်
app.get('/api/vehicles', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.id, c.name as owner, v.license_plate as plate, v.model, 
             TO_CHAR(v.created_at, 'DD Mon YYYY') as last_visit,
             'In Shop' as status -- ယာယီအားဖြင့် Status ကို အသေထားပြပါမည်
      FROM vehicles v
      LEFT JOIN customers c ON v.customer_id = c.id
      ORDER BY v.id DESC
    `);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching vehicles ❌:', error);
    res.status(500).json({ success: false });
  }
});

// (ခ) ကားအချက်အလက် အသစ်ထည့်ရန် (POST)
app.post('/api/vehicles', async (req, res) => {
  try {
    const { owner, plate, model } = req.body;
    
    // ပထမဦးစွာ owner နာမည်နဲ့ customer ကို ရှာမည်၊ မရှိရင် အသစ်တည်ဆောက်မည်
    let customerId;
    const cusCheck = await pool.query('SELECT id FROM customers WHERE name = $1 LIMIT 1', [owner]);
    
    if (cusCheck.rows.length > 0) {
      customerId = cusCheck.rows[0].id;
    } else {
      const newCus = await pool.query('INSERT INTO customers (name) VALUES ($1) RETURNING id', [owner]);
      customerId = newCus.rows[0].id;
    }

    // ထို့နောက် vehicles ဇယားထဲသို့ သွားသိမ်းမည်
    await pool.query(
      'INSERT INTO vehicles (customer_id, model, license_plate) VALUES ($1, $2, $3)',
      [customerId, model, plate]
    );

    res.status(201).json({ success: true, message: 'Vehicle added successfully!' });
  } catch (error) {
    console.error('Error adding vehicle ❌:', error);
    res.status(500).json({ success: false });
  }
});

// (ဂ) ကားအချက်အလက် ပြင်ဆင်ရန် (PUT)
app.put('/api/vehicles/:id', async (req, res) => {
  try {
    const { plate, model, owner } = req.body;
    
    // ကားအချက်အလက်ကို Update လုပ်မည်
    const vehRes = await pool.query(
      'UPDATE vehicles SET model = $1, license_plate = $2 WHERE id = $3 RETURNING customer_id',
      [model, plate, req.params.id]
    );

    // ပိုင်ရှင်နာမည်ပါ ပြောင်းခဲ့လျှင် Customers ဇယားကိုပါ သွားပြင်မည်
    if (vehRes.rows.length > 0) {
        const cusId = vehRes.rows[0].customer_id;
        await pool.query('UPDATE customers SET name = $1 WHERE id = $2', [owner, cusId]);
    }

    res.status(200).json({ success: true, message: 'Vehicle updated!' });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ဃ) ကားမှတ်တမ်း ဖျက်ရန် (DELETE)
app.delete('/api/vehicles/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM vehicles WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// 🚀 12. CAR WASH APIs (ကားရေဆေး မှတ်တမ်းများအတွက်)  // မှတ်ချက် - ဒီနေရာမှာ နံပါတ် ၁၂ နှစ်ခါထပ်နေတာ မူရင်းအတိုင်း ထားပေးထားပါတယ်
// ==========================================

// (က) ရေဆေးမှတ်တမ်းအားလုံး ပြန်ခေါ်ရန် (GET)
app.get('/api/wash-jobs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM wash_jobs ORDER BY id DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching wash jobs ❌:', error);
    res.status(500).json({ success: false });
  }
});

// (ခ) ရေဆေးမှတ်တမ်း အသစ်ထည့်ရန် (POST)
app.post('/api/wash-jobs', async (req, res) => {
  try {
    const { job_id, customer, phone, car, plate, size, service, price, status, date } = req.body;
    await pool.query(
      `INSERT INTO wash_jobs (job_id, customer_name, phone, car_model, plate_number, car_size, service_type, price, status, job_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [job_id, customer, phone, car, plate, size, service, price, status, date]
    );
    res.status(201).json({ success: true, message: 'Wash job created!' });
  } catch (error) {
    console.error('Error creating wash job ❌:', error);
    res.status(500).json({ success: false });
  }
});

// (ဂ) ရေဆေးမှတ်တမ်း အခြေအနေ (Status) ပြင်ဆင်ရန် (PUT)
app.put('/api/wash-jobs/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE wash_jobs SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ဃ) ရေဆေးမှတ်တမ်း ဖျက်ရန် (DELETE)
app.delete('/api/wash-jobs/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM wash_jobs WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// 🚀 13. WORKSHOP & BAYS APIs (အလုပ်ရုံနေရာများနှင့် မှတ်တမ်းများအတွက်)
// ==========================================

// (က) Bay အားလုံး၏ လက်ရှိအခြေအနေကို ရယူရန်
app.get('/api/bays', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bays ORDER BY bay_name ASC');
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ခ) အခြား Module များမှ Pending ဖြစ်နေသော အလုပ်များကို လှမ်းဆွဲရန်
app.get('/api/workshop/pending', async (req, res) => {
  try {
    const jobs = await pool.query("SELECT job_id as id, car, tech, task as type, 'Job Card' as source FROM job_cards WHERE status = 'In Progress'");
    const washes = await pool.query("SELECT job_id as id, car_model as car, 'Unassigned' as tech, service_type as type, 'Wash & Detail' as source FROM wash_jobs WHERE status = 'In Progress'");
    res.status(200).json([...jobs.rows, ...washes.rows]);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ဂ) Bay သို့ ကားစတင်ထည့်သွင်းရန် (Assign Car)
app.put('/api/bays/:id/assign', async (req, res) => {
  try {
    const { session_id, car, tech, type, task_id, source, start_time } = req.body;
    await pool.query(
      `UPDATE bays 
       SET status = 'In Use', session_id = $1, car = $2, tech = $3, service_type = $4, task_id = $5, source = $6, start_time = $7 
       WHERE id = $8`,
      [session_id, car, tech, type, task_id, source, start_time, req.params.id]
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ဃ) ကားပြင်ဆင်ပြီးစီးကြောင်း သတ်မှတ်ရန် (Mark Completed & Auto-Sync)
app.put('/api/bays/:id/complete', async (req, res) => {
  try {
    const { complete_time, task_id, source } = req.body;
    
    // Bay ကို Completed ပြောင်းမည်
    await pool.query(`UPDATE bays SET status = 'Completed', complete_time = $1 WHERE id = $2`, [complete_time, req.params.id]);

    // Cross-Module Auto-Sync (Job Card သို့မဟုတ် Wash Job ထဲမှာပါ Completed အလိုလိုပြောင်းမည်)
    if (task_id && source === 'Job Card') {
      await pool.query(`UPDATE job_cards SET status = 'Completed', progress = 100 WHERE job_id = $1`, [task_id]);
    } else if (task_id && source === 'Wash & Detail') {
      await pool.query(`UPDATE wash_jobs SET status = 'Completed' WHERE job_id = $1`, [task_id]);
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (င) ကားလာယူသွားကြောင်း သတ်မှတ်ရန် (Collect Car & Save History)
app.put('/api/bays/:id/collect', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { session_id, bay_name, car, tech, type, start_time, complete_time } = req.body;
    
    // ၁။ History ထဲသို့ မှတ်တမ်းတင်မည်
    await client.query(
      `INSERT INTO service_history (session_id, bay_name, car, tech, service_type, start_time, complete_time) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [session_id, bay_name, car, tech, type, start_time, complete_time]
    );

    // ၂။ Bay ကို ရှင်းထုတ်မည် (Available ပြန်ဖြစ်မည်)
    await client.query(
      `UPDATE bays 
       SET status = 'Available', session_id = NULL, car = '--', tech = '--', service_type = 'General Service', start_time = NULL, complete_time = NULL, task_id = NULL, source = NULL 
       WHERE id = $1`, 
      [req.params.id]
    );

    await client.query('COMMIT');
    res.status(200).json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false });
  } finally {
    client.release();
  }
});

// (စ) Service History အားလုံးကို ရယူရန်
app.get('/api/workshop/history', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM service_history ORDER BY id DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// (ဆ) Bay အခြေအနေ ပြင်ဆင်ရန် (Maintenance / Available ပြောင်းရန်)
app.put('/api/bays/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query("UPDATE bays SET status = $1 WHERE id = $2", [status, req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// 🚀 14. AUTHENTICATION APIs (လုံခြုံရေး ဂိတ်ပေါက်အတွက်)
// ==========================================

// (က) Login ဝင်ရန် စစ်ဆေးခြင်း (POST) - (အပေါ်မှာ ထပ်နေတဲ့ Create User ကုဒ်အပိုကို ဒီထဲကနေ ဖယ်ရှားလိုက်ပါပြီ)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // ၁။ Master Admin
    const masterCheck = await pool.query('SELECT master_email, master_password, master_avatar FROM workshop_settings WHERE id = 1');
    const masterEmail = masterCheck.rows.length > 0 ? masterCheck.rows[0].master_email : 'admin@ontimeauto.com';
    const masterPass = masterCheck.rows.length > 0 && masterCheck.rows[0].master_password ? masterCheck.rows[0].master_password : 'admin123';
    
    if (username === masterEmail && password === masterPass) { 
      return res.status(200).json({ 
        success: true, 
        user: { name: 'Master Admin', role: 'Admin', email: masterEmail, avatar: masterCheck.rows[0].master_avatar } 
      });
    }

    // ၂။ Sub-accounts
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND password = $2 AND status = $3', 
      [username, password, 'Active']
    );
    
    if (userCheck.rows.length > 0) {
      const user = userCheck.rows[0];
      return res.status(200).json({ 
        success: true, 
        user: { name: user.name, role: user.role, email: user.email, avatar: user.avatar } 
      });
    }

    res.status(401).json({ success: false, message: 'Invalid credentials or inactive account' });
  } catch (error) {
    console.error('Login Error ❌:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==========================================
// 🚀 15. J.A.R.V.I.S AI ENGINE (Google Gemini Integration)
// ==========================================

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    // API Key စစ်ဆေးခြင်း
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ reply: "System Error: Gemini API Key is missing in the server configuration." });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-pro" });

    // 🧠 AI အတွက် Database ထဲမှ အချက်အလက်များကို ဆွဲထုတ်ခြင်း
    const invRes = await pool.query('SELECT name, stock FROM inventory WHERE stock < 10');
    const jobsRes = await pool.query("SELECT car, task, status FROM job_cards WHERE status != 'Completed'");
    const washRes = await pool.query("SELECT car_model, service_type, status FROM wash_jobs WHERE status != 'Completed'");

    // 🤖 AI ကို သူ့ရဲ့ တာဝန်နဲ့ Database အခြေအနေကို ရှင်းပြခြင်း (System Prompt)
    let systemContext = `
      You are J.A.R.V.I.S, the highly intelligent and professional AI assistant for 'ON TIME Auto Service' center in Yangon.
      Always be polite, concise, and helpful. Use a professional yet slightly sci-fi tone.
      
      Here is the CURRENT REAL-TIME DATA from the workshop's database:
      1. Low Stock Inventory Alerts: ${JSON.stringify(invRes.rows)}
      2. Active Job Cards (Repairs): ${JSON.stringify(jobsRes.rows)}
      3. Active Wash & Detailing Jobs: ${JSON.stringify(washRes.rows)}
      
      Based ONLY on the above data and your general knowledge about auto repairs, answer the user's question.
      If the user asks something not related to the auto service or the provided data, politely guide them back to workshop operations.
      
      User's Request: ${message}
    `;

    // Gemini ထံသို့ ပို့ပြီး အဖြေတောင်းခြင်း
    const result = await model.generateContent(systemContext);
    const aiResponse = result.response.text();

    res.status(200).json({ reply: aiResponse });
  } catch (error) {
    console.error('J.A.R.V.I.S Engine Error ❌:', error);
    res.status(500).json({ reply: "Network Error: J.A.R.V.I.S neural link is currently unstable. Please try again later." });
  }
});

// ==========================================
// 🚀 UPLOAD AVATAR API
// ==========================================
app.post('/api/upload-avatar', upload.single('avatar'), async (req, res) => {
  try {
    const { email, role } = req.body;
    const imageUrl = `https://api.ontimeauto.site/uploads/${req.file.filename}`;

    if (role === 'Admin' || role === 'Super Admin') {
      await pool.query('UPDATE workshop_settings SET master_avatar = $1 WHERE id = 1', [imageUrl]);
    } else {
      await pool.query('UPDATE users SET avatar = $1 WHERE email = $2', [imageUrl, email]);
    }
    res.status(200).json({ success: true, imageUrl });
  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).json({ success: false });
  }
});
