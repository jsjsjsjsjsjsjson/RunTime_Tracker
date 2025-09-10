const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = 3000;
const SECRET = 'your-secret-key';

// 中间件
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));


// MongoDB连接
mongoose.connect('mongodb://mongo_DbY3f234:mongo_r4Zzi334r@192.168.43.46:27017/deviceStats')
    .then(() => console.log('成功连接到 MongoDB'))
    .catch(err => console.error('MongoDB 连接错误:', err))



// 定义数据模型
const UsageRecord = mongoose.model('UsageRecord', {
    deviceId: String,
    appName: String,
    startTime: Date,
    endTime: Date,
    duration: Number, // 分钟
    date: Date // 添加日期字段用于查询
});

// 获取设备列表
async function getDevices() {
    // 获取所有有记录的设备ID
    const devices = await UsageRecord.distinct('deviceId');

    // 获取每个设备的最后状态
    const deviceStatus = await Promise.all(devices.map(async deviceId => {
        const lastRecord = await UsageRecord.findOne({ deviceId })
            .sort({ startTime: -1 })
            .limit(1);

        return {
            device: deviceId,
            currentApp: lastRecord.appName,
            running: lastRecord.endTime === null,
            runningSince: lastRecord.startTime
        };
    }));

    return deviceStatus;
}

// 记录应用使用时间
async function recordUsage(deviceId, appName) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 查找当前设备的最后一条记录
    const lastRecord = await UsageRecord.findOne({
        deviceId,
        endTime: null
    }).sort({ startTime: -1 });

    // 如果应用切换了，更新上一条记录的结束时间
    if (lastRecord && lastRecord.appName !== appName) {
        lastRecord.endTime = now;
        lastRecord.duration = Math.round((now - lastRecord.startTime) / 60000);
        await lastRecord.save();
    }

    // 创建新记录
    const newRecord = new UsageRecord({
        deviceId,
        appName,
        startTime: now,
        endTime: null,
        duration: 0,
        date: today
    });

    await newRecord.save();
}

// 停止应用时更新记录
async function stopUsage(deviceId) {
    const now = new Date();
    const lastRecord = await UsageRecord.findOne({
        deviceId,
        endTime: null
    }).sort({ startTime: -1 });

    if (lastRecord) {
        lastRecord.endTime = now;
        lastRecord.duration = Math.round((now - lastRecord.startTime) / 60000);
        await lastRecord.save();
    }
}

// 获取某天的统计数据
async function getDailyStats(deviceId, date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const records = await UsageRecord.find({
        deviceId,
        startTime: { $gte: startOfDay, $lte: endOfDay }
    });

    // 计算统计信息
    const stats = {
        totalUsage: records.reduce((sum, record) => sum + record.duration, 0),
        appStats: {},
        hourlyStats: Array(24).fill(0),
        appHourlyStats: {}
    };

    records.forEach(record => {
        // 按应用统计总时间
        stats.appStats[record.appName] = (stats.appStats[record.appName] || 0) + record.duration;

        // 按小时统计使用时间
        const hour = record.startTime.getHours();
        stats.hourlyStats[hour] += record.duration;

        // 按应用统计每小时使用时间
        if (!stats.appHourlyStats[record.appName]) {
            stats.appHourlyStats[record.appName] = Array(24).fill(0);
        }
        stats.appHourlyStats[record.appName][hour] += record.duration;
    });

    return stats;
}

// API端点
app.post('/api', async (req, res) => {
    const { secret, device, app_name, running } = req.body;

    if (secret !== SECRET) {
        return res.status(401).json({ error: 'Invalid secret' });
    }

    if (!device) {
        return res.status(400).json({ error: 'Missing device' });
    }

    if (running !== false && !app_name) {
        return res.status(400).json({ error: 'Missing app_name when running is true' });
    }

    try {
        if (running !== false) {
            await recordUsage(device, app_name);
        } else {
            await stopUsage(device);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 获取设备列表
app.get('/api/devices', async (req, res) => {
    try {
        const devices = await getDevices();
        res.json(devices);
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 获取某天的统计数据
app.get('/api/stats/:deviceId/:date', async (req, res) => {
    try {
        const date = new Date(req.params.date);
        if (isNaN(date.getTime())) {
            return res.status(400).json({ error: 'Invalid date format' });
        }

        const stats = await getDailyStats(req.params.deviceId, date);
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/stats/:deviceId', async (req, res) => {
    try {
        const date = new Date();
        date.setHours(0, 0, 0, 0);

        const stats = await getDailyStats(req.params.deviceId, date);
        res.json(stats);
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
