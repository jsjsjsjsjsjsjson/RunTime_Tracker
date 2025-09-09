const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;
const SECRET = 'your-secret-key';

// 中间件
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// 设备数据库
let devices = [];

// 记录应用使用时间
function recordUsage(deviceId, appName) {
    const now = new Date();
    const device = devices.find(d => d.device === deviceId);

    if (!device) return;

    // 如果应用切换了，记录上一个应用的使用时间
    if (device.app_name !== appName && device.running) {
        const lastUsage = {
            app_name: device.app_name,
            start: device.startTime,
            end: now,
            duration: Math.round((now - device.startTime) / 60000) // 分钟
        };

        device.usageHistory.push(lastUsage);
    }

    // 更新当前应用信息
    device.app_name = appName;
    device.running = true;
    device.startTime = now;
}

// 获取设备使用统计
function getDeviceStats(deviceId) {
    const device = devices.find(d => d.device === deviceId);
    if (!device) return null;

    // 按应用统计总时间
    const appStats = {};
    device.usageHistory.forEach(usage => {
        appStats[usage.app_name] = (appStats[usage.app_name] || 0) + usage.duration;
    });

    // 按小时统计使用时间
    const hourlyStats = Array(24).fill(0);
    device.usageHistory.forEach(usage => {
        const hour = new Date(usage.start).getHours();
        hourlyStats[hour] += usage.duration;
    });

    // 按应用统计每小时使用时间
    const appHourlyStats = {};
    device.usageHistory.forEach(usage => {
        const hour = new Date(usage.start).getHours();
        const app = usage.app_name;

        if (!appHourlyStats[app]) {
            appHourlyStats[app] = Array(24).fill(0);
        }

        appHourlyStats[app][hour] += usage.duration;
    });

    return {
        totalUsage: device.usageHistory.reduce((sum, usage) => sum + usage.duration, 0),
        appStats,
        hourlyStats,
        appHourlyStats,
        currentApp: device.app_name,
        currentAppRunningTime: device.running ? Math.round((new Date() - device.startTime) / 60000) : 0
    };
}

// API端点
app.post('/api', (req, res) => {
    const { secret, device, app_name } = req.body;

    if (secret !== SECRET) {
        return res.status(401).json({ error: 'Invalid secret' });
    }

    if (!device || !app_name) {
        return res.status(400).json({ error: 'Missing device or app_name' });
    }

    // 查找或创建设备
    const existingDevice = devices.find(d => d.device === device);
    if (!existingDevice) {
        devices.push({
            device,
            app_name,
            running: true,
            startTime: new Date(),
            usageHistory: []
        });
    } else {
        recordUsage(device, app_name);
    }

    res.json({ success: true });
});

// 获取设备列表
app.get('/api/devices', (req, res) => {
    res.json(devices.map(device => ({
        device: device.device,
        currentApp: device.app_name,
        running: device.running,
        runningSince: device.startTime
    })));
});

// 获取设备统计
app.get('/api/stats/:deviceId', (req, res) => {
    const stats = getDeviceStats(req.params.deviceId);
    if (stats) {
        res.json(stats);
    } else {
        res.status(404).json({ error: 'Device not found' });
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
