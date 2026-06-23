const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'slots.json');
const ADMIN_PASSWORD = 'admin888';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- 数据读写（JSON 文件存储，带读写锁防止并发冲突） ----
let writeLock = Promise.resolve();

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return []; }
}

function writeData(slots) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(slots, null, 2), 'utf8');
}

// 原子写入：确保同时只有一个写操作（防并发冲突）
function atomicWrite(updater) {
  writeLock = writeLock.then(() => {
    const data = readData();
    const result = updater(data);
    writeData(result.data);
    return result;
  });
  return writeLock;
}

// ---- 初始化示例数据 ----
function ensureSampleData() {
  if (fs.existsSync(DATA_FILE)) return;
  var days = [
    { date: '2026-06-26', label: '6月26日 (周五)' },
    { date: '2026-06-27', label: '6月27日 (周六)' },
    { date: '2026-06-28', label: '6月28日 (周日)' }
  ];
  var tSlots = [
    {s:'06:00',e:'07:00'},{s:'07:00',e:'08:00'},{s:'08:15',e:'09:15'},{s:'09:30',e:'10:30'},{s:'10:45',e:'11:45'},
    {s:'13:00',e:'14:00'},{s:'14:15',e:'15:15'},{s:'15:30',e:'16:30'},{s:'16:45',e:'17:45'},
    {s:'18:30',e:'19:30'},{s:'19:45',e:'20:45'},{s:'21:00',e:'22:00'},{s:'22:15',e:'23:15'},{s:'23:30',e:'00:30'}
  ];
  var slots = []; var o = 1;
  for (var d = 0; d < days.length; d++) {
    var day = days[d];
    for (var t = 0; t < tSlots.length; t++) {
      var ts = tSlots[t];
      var tl = ts.s+'-'+ts.e + (ts.e === '00:30' ? ' (次日)' : '');
      slots.push({
        id: 's_'+o, label: day.label+' '+tl, dateLabel: day.label,
        timeLabel: tl, startOrder: o++, booked: false,
        childName: '', bookedAt: null, createdAt: new Date().toISOString()
      });
    }
  }
  var dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(slots, null, 2), 'utf8');
  console.log('已初始化 '+slots.length+' 个时段 (6月26-28日)');
}// ---- API 路由 ----

// 获取所有时段
app.get('/api/slots', (req, res) => {
  const data = readData();
  const result = data.map(s => ({
    id: s.id,
    label: s.label,
    dateLabel: s.dateLabel,
    timeLabel: s.timeLabel,
    booked: s.booked,
    childName: s.booked ? s.childName : null,
    order: s.startOrder
  }));
  res.json({ success: true, data: result });
});

// 预约时段（原子操作）
app.post('/api/book', async (req, res) => {
  const { slotId, childName } = req.body;

  if (!slotId || !childName || !childName.trim()) {
    return res.status(400).json({ success: false, message: '请填写孩子姓名' });
  }

  const result = await atomicWrite((data) => {
    const slot = data.find(s => s.id === slotId);
    if (!slot) {
      return { data, conflict: true, message: '时段不存在' };
    }
    if (slot.booked) {
      return { data, conflict: true, message: '该时段已被其他家长预约，请选择其他时段' };
    }
    slot.booked = true;
    slot.childName = childName.trim();
    slot.bookedAt = new Date().toISOString();
    return { data, conflict: false, message: '预约成功！' };
  });

  if (result.conflict) {
    return res.status(409).json({ success: false, message: result.message });
  }
  res.json({ success: true, message: result.message });
});

// 管理：添加时段
app.post('/api/admin/slots', async (req, res) => {
  const { slots: newSlots, password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, message: '密码错误' });
  }
  if (!Array.isArray(newSlots) || newSlots.length === 0) {
    return res.status(400).json({ success: false, message: '请提供时段数据' });
  }

  await atomicWrite((data) => {
    const maxOrder = data.reduce((max, s) => Math.max(max, s.startOrder || 0), 0);
    let nextOrder = maxOrder + 1;
    for (const slot of newSlots) {
      data.push({
        id: `slot_${nextOrder}`,
        label: slot.label,
        dateLabel: slot.dateLabel || '',
        timeLabel: slot.timeLabel || '',
        startOrder: nextOrder++,
        booked: false,
        childName: '',
        phone: '',
        bookedAt: null,
        createdAt: new Date().toISOString()
      });
    }
    return { data };
  });

  res.json({ success: true, message: `成功添加 ${newSlots.length} 个时段` });
});

// 管理：重置预约
app.post('/api/admin/reset', async (req, res) => {
  const { slotId, password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, message: '密码错误' });
  }

  await atomicWrite((data) => {
    const slot = data.find(s => s.id === slotId);
    if (slot) {
      slot.booked = false;
      slot.childName = '';
      slot.phone = '';
      slot.bookedAt = null;
    }
    return { data };
  });

  res.json({ success: true, message: '已重置' });
});

// 管理：删除时段
app.post('/api/admin/delete', async (req, res) => {
  const { slotId, password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, message: '密码错误' });
  }

  await atomicWrite((data) => {
    const idx = data.findIndex(s => s.id === slotId);
    if (idx !== -1) data.splice(idx, 1);
    return { data };
  });

  res.json({ success: true, message: '已删除' });
});

// ---- 启动 ----
ensureSampleData();

app.listen(PORT, () => {
  console.log(`预约系统已启动：http://localhost:${PORT}`);
  console.log(`家长端：http://localhost:${PORT}`);
  console.log(`管理密码：${ADMIN_PASSWORD}`);
});
