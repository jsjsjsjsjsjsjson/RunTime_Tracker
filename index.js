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

// 电量统计临时存储
const batteryStats = new Map();

function recordBattery(deviceId, level) {
    const now = new Date();
    if (!batteryStats.has(deviceId)) {
        batteryStats.set(deviceId, []);
    }
    batteryStats.get(deviceId).push({
        timestamp: now,
        level: level
    });

    // 保留最近100条记录
    if (batteryStats.get(deviceId).length > 100) {
        batteryStats.get(deviceId).shift();
    }
}
// 获取电量记录
function getBatteryStats(deviceId) {
    return batteryStats.get(deviceId) || [];
}

// 获取设备列表
async function getDevices() {
    return Array.from(recentAppSwitches.keys()).map(deviceId => {
        let currentApp = "Unknown";
        let runningSince = new Date();
        let isRunning = true;
        let batteryLevel = 0;

        // 获取最近电量
        const batteryRecords = getBatteryStats(deviceId);
        if (batteryRecords.length > 0) {
            batteryLevel = batteryRecords[batteryRecords.length - 1].level;
        }

        // 获取应用状态
        if (recentAppSwitches.has(deviceId) && recentAppSwitches.get(deviceId).length > 0) {
            const lastSwitch = recentAppSwitches.get(deviceId)[0];
            currentApp = lastSwitch.appName;
            runningSince = lastSwitch.timestamp;
            isRunning = lastSwitch.running !== false;
        }

        return {
            device: deviceId,
            currentApp,
            running: isRunning,
            runningSince,
            batteryLevel
        };
    });
}



// 记录应用使用时间
async function recordUsage(deviceId, appName, running) {
    const now = new Date();

    if (!recentAppSwitches.has(deviceId)) {
        recentAppSwitches.set(deviceId, []);
    }

    const deviceSwitches = recentAppSwitches.get(deviceId);

    // 处理停止运行的情况
    if (running === false) {
        if (deviceSwitches.length > 0) {
            const lastSwitch = deviceSwitches[0];
            // 计算从上次记录到当前时间的持续时间
            if (lastSwitch.running !== false) {
                const minutesSinceLastSwitch = Math.round((now - lastSwitch.timestamp) / 60000);
                await updateDailyStat(deviceId, lastSwitch.appName, lastSwitch.timestamp, minutesSinceLastSwitch);
            }
            // 更新最后一条记录的状态为停止
            deviceSwitches[0].running = false;
            // 添加停止记录点
            deviceSwitches.unshift({
                appName: "设备待机",
                timestamp: now,
                running: false
            });
        }
        return;
    }

    // 原有计算使用时间的逻辑
    let minutesSinceLastSwitch = 0;
    if (deviceSwitches.length > 0) {
        const lastSwitch = deviceSwitches[0];
        // 如果设备正在运行才计算时间
        if (lastSwitch.running !== false) {
            minutesSinceLastSwitch = Math.round((now - lastSwitch.timestamp) / 60000);
            await updateDailyStat(deviceId, lastSwitch.appName, lastSwitch.timestamp, minutesSinceLastSwitch);
        }
    }

    // 添加新记录
    deviceSwitches.unshift({
        appName: appName,
        timestamp: now,
        running: true
    });

    if (deviceSwitches.length > 20) {
        deviceSwitches.pop();
    }
}


// 更新每日统计
async function updateDailyStat(deviceId, appName, timestamp, durationMinutes) {
    // 如果没有有效的时长则不处理
    if (durationMinutes <= 0) return;

    let remaining = durationMinutes;
    let currentTime = new Date(timestamp);

    while (remaining > 0) {
        const date = new Date(currentTime);
        date.setHours(0, 0, 0, 0);

        const hour = currentTime.getHours();
        const nextHour = new Date(currentTime);
        nextHour.setHours(hour + 1, 0, 0, 0);

        const minutesThisHour = Math.min(
            remaining,
            Math.ceil((nextHour - currentTime) / 60000)
        );

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

        stat.hourlyUsage[hour] += minutesThisHour;
        await stat.save();

        remaining -= minutesThisHour;
        currentTime = nextHour;
    }
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
    const { secret, device, app_name, running, batteryLevel } = req.body;

    if (secret !== SECRET) {
        return res.status(401).json({ error: 'Invalid secret' });
    }

    if (!device) {
        return res.status(400).json({ error: 'Missing device' });
    }

    if (running !== false && !app_name) {
        return res.status(400).json({ error: 'Missing app_name when running is true' });
    }

    if (batteryLevel !== undefined && batteryLevel > 0 && batteryLevel < 101) {
        recordBattery(device, batteryLevel);
    }

    try {
        await recordUsage(device, app_name, running, batteryLevel);
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
            const switchEntries = [...recentAppSwitches.get(deviceId)].reverse();

            records = switchEntries.map((entry, index) => {
                const startTime = entry.timestamp;
                let endTime = new Date();
                let duration = 0;

                // 如果是停止记录且不是最后一条
                if (entry.running === false && index < switchEntries.length - 1) {
                    // 使用下一条记录的时间作为结束时间
                    endTime = switchEntries[index + 1].timestamp;
                    duration = Math.round((endTime - startTime) / 1000);
                }
                // 如果是最后一条记录且标记为停止
                else if (entry.running === false) {
                    endTime = startTime;
                    duration = 0;
                }
                // 如果是运行中的记录且不是最后一条
                else if (index < switchEntries.length - 1) {
                    endTime = switchEntries[index + 1].timestamp;
                    duration = Math.round((endTime - startTime) / 1000);
                }
                // 如果是最后一条运行中的记录
                else {
                    duration = Math.round((endTime - startTime) / 1000);
                }

                return {
                    appName: entry.appName,
                    startTime: startTime,
                    endTime: endTime,
                    duration: duration,
                    running: entry.running !== false
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

// IP地址获取
function getClientIp(req) {
    // 优先从X-Forwarded-For获取(适用于反向代理场景)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return typeof forwarded === 'string'
            ? forwarded.split(',')[0].trim()
            : forwarded[0].trim();
    }

    // 如果没有代理，直接使用connection的remoteAddress
    return req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip;
}

// 获取客户端IP地址
app.get('/api/ip', (req, res) => {
    const clientIp = getClientIp(req);
    res.json({ ip: clientIp });
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});