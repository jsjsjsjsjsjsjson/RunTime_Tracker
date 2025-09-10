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

// 定义新的数据模型 - 按天/小时/应用存储
const DailyStat = mongoose.model('DailyStat', {
    deviceId: String,
    date: Date,       // 日期部分 (YYYY-MM-DD)
    appName: String,
    hourlyUsage: [Number] // 24小时数组，每项代表分钟数
});

// 应用切换记录 - 临时保存在内存中
const recentAppSwitches = new Map(); // {deviceId: [{appName, timestamp}]}

// 获取设备列表
async function getDevices() {
    // 获取所有有记录的设备ID
    const devices = await DailyStat.distinct('deviceId');

    // 获取每个设备的最后状态
    return await Promise.all(devices.map(async deviceId => {
        // 从最近切换记录获取当前应用和开始时间
        let currentApp = "Unknown";
        let runningSince = new Date(); // 默认当前时间

        if (recentAppSwitches.has(deviceId) && recentAppSwitches.get(deviceId).length > 0) {
            const lastSwitch = recentAppSwitches.get(deviceId)[0];
            currentApp = lastSwitch.appName;
            runningSince = lastSwitch.timestamp;
        } else {
            // 如果没有切换记录，尝试从数据库获取最后记录
            const lastStat = await DailyStat.findOne({deviceId})
                .sort({date: -1})
                .limit(1);

            if (lastStat) {
                runningSince = lastStat.date;
            }
        }

        return {
            device: deviceId,
            currentApp: currentApp,
            running: true, // 简化处理，始终显示运行中
            runningSince: runningSince
        };
    }));
}


// 记录应用使用时间
async function recordUsage(deviceId, appName) {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0); // 当天起始时间

    // 管理最近应用切换记录
    if (!recentAppSwitches.has(deviceId)) {
        recentAppSwitches.set(deviceId, []);
    }

    const deviceSwitches = recentAppSwitches.get(deviceId);

    // 计算与上一次切换的时间间隔（分钟）
    let minutesSinceLastSwitch = 0;
    if (deviceSwitches.length > 0) {
        const lastSwitch = deviceSwitches[0];
        minutesSinceLastSwitch = Math.round((now - lastSwitch.timestamp) / 60000);

        // 更新上一个应用的使用时间
        if (minutesSinceLastSwitch > 0) {
            await updateDailyStat(
                deviceId,
                lastSwitch.appName,
                lastSwitch.timestamp,
                minutesSinceLastSwitch
            );
        }
    }

    // 添加新记录到开头
    deviceSwitches.unshift({
        appName: appName,
        timestamp: now
    });

    // 只保留最近20条记录
    if (deviceSwitches.length > 20) {
        deviceSwitches.pop();
    }
}

// 更新每日统计
async function updateDailyStat(deviceId, appName, timestamp, durationMinutes) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);

    const hour = timestamp.getHours();

    // 查找或创建统计记录
    let stat = await DailyStat.findOne({
        deviceId,
        date,
        appName
    });

    if (!stat) {
        stat = new DailyStat({
            deviceId,
            date,
            appName,
            hourlyUsage: Array(24).fill(0)
        });
    }

    // 增加当前小时的使用时间（基于实际时间间隔）
    stat.hourlyUsage[hour] += durationMinutes;
    await stat.save();
}

// 获取某天的统计数据
async function getDailyStats(deviceId, date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    // 获取当天所有应用的统计
    const stats = await DailyStat.find({
        deviceId,
        date: startOfDay
    });

    // 初始化结果结构
    const result = {
        totalUsage: 0,
        appStats: {},
        hourlyStats: Array(24).fill(0),
        appHourlyStats: {}
    };

    // 聚合统计数据
    stats.forEach(stat => {
        const appName = stat.appName;

        // 应用总时长
        const appTotal = stat.hourlyUsage.reduce((sum, val) => sum + val, 0);
        result.appStats[appName] = appTotal;
        result.totalUsage += appTotal;

        // 初始化应用小时统计
        if (!result.appHourlyStats[appName]) {
            result.appHourlyStats[appName] = Array(24).fill(0);
        }

        // 聚合小时数据
        stat.hourlyUsage.forEach((minutes, hour) => {
            result.hourlyStats[hour] += minutes;
            result.appHourlyStats[appName][hour] += minutes;
        });
    });

    return result;
}

// API端点保持不变
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

// 获取最近30条应用切换记录
app.get('/api/recent/:deviceId', async (req, res) => {
    try {
        const deviceId = req.params.deviceId;
        let records = [];

        if (recentAppSwitches.has(deviceId)) {
            // 获取并反转数组，使最新的记录在最后
            const switchEntries = [...recentAppSwitches.get(deviceId)].reverse();

            records = switchEntries.map((entry, index) => {
                const startTime = entry.timestamp;
                let endTime = new Date(); // 默认当前时间

                // 如果不是最后一条记录，则用下一条记录的时间作为结束时间
                if (index < switchEntries.length - 1) {
                    endTime = switchEntries[index + 1].timestamp;
                }

                const duration = Math.round((endTime - startTime) / 1000);

                return {
                    appName: entry.appName,
                    startTime: startTime,
                    endTime: endTime,
                    duration: duration
                };
            });
        }

        res.json(records.slice(0, 30));
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});



// 获取某天统计数据
app.get('/api/stats/:deviceId/:date', async (req, res) => {
    try {
        const dateStr = req.params.date;
        const date = new Date(dateStr);

        if (isNaN(date.getTime())) {
            return res.status(400).json({ error: 'Invalid date format. Please use YYYY-MM-DD format.' });
        }

        date.setHours(0, 0, 0, 0);
        const stats = await getDailyStats(req.params.deviceId, date);

        if (!stats) {
            return res.status(404).json({ error: 'No records found for this date' });
        }

        res.json(stats);
    } catch (error) {
        console.error('Error in /api/stats/:deviceId/:date:', error);
        res.status(500).json({
            error: 'Database error',
            details: error.message
        });
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
