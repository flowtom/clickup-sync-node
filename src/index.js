const express = require('express');
const db = require('./db');
const sync = require('./services/sync');

const app = express();
app.use(express.json());

// Add logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Test route to verify Express is working
app.get('/test', (req, res) => {
  console.log('Test endpoint hit');
  res.json({ status: 'ok' });
});

// Webhook endpoint for real-time updates
app.post('/webhook', async (req, res) => {
  console.log('Webhook endpoint hit:', req.body);
  try {
    const { task_id, event } = req.body;
    if (task_id && ['taskUpdated', 'taskCreated'].includes(event)) {
      await sync.syncTaskCustomFields(task_id);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get recent changes
app.get('/api/recent-changes', async (req, res) => {
  console.log('Recent changes endpoint hit, minutes:', req.query.minutes);
  try {
    const minutes = parseInt(req.query.minutes) || 60;
    const changes = await db.getRecentChanges(minutes);
    res.json(changes);
  } catch (error) {
    console.error('Error fetching recent changes:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get task data
app.get('/api/task/:taskId', async (req, res) => {
  try {
    const task = await db.getTaskById(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(task);
  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add this endpoint for manual syncs
app.post('/api/task/:taskId/sync', async (req, res) => {
  try {
    const { taskId } = req.params;
    console.log(`Starting manual sync for task ${taskId}`);

    // Try both custom fields and relationships sync
    await Promise.all([
      sync.syncTaskCustomFields(taskId),
      sync.syncTaskRelationships(taskId)
    ]);

    // Get the updated task data to return
    const updatedTask = await db.getTaskById(taskId);
    
    res.json({ 
      success: true, 
      message: `Successfully synced task ${taskId}`,
      task: updatedTask
    });

  } catch (error) {
    console.error('Sync error:', {
      taskId: req.params.taskId,
      error: error.message,
      stack: error.stack
    });
    
    // Send appropriate error response
    if (error.response?.status === 404) {
      res.status(404).json({ 
        error: 'Task not found in ClickUp',
        taskId: req.params.taskId
      });
    } else {
      res.status(500).json({ 
        error: error.message,
        taskId: req.params.taskId
      });
    }
  }
});

// Initialize application
async function start() {
  try {
    console.log('Starting application...');
    
    // First check database connection
    console.log('Checking database connection...');
    const connected = await db.checkConnection();
    if (!connected) {
      throw new Error('Could not establish database connection');
    }
    console.log('Database connection successful');

    // Initialize tables
    console.log('Initializing database tables...');
    await db.initializeTables();
    console.log('Database tables initialized');

    // Start server
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log('Available endpoints:');
      console.log('- GET /test');
      console.log('- POST /webhook');
      console.log('- GET /api/recent-changes');
      console.log('- GET /api/task/:taskId');
      console.log('- POST /api/task/:taskId/sync  <- Manual sync endpoint');
    });
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

start(); 