require('dotenv').config();

module.exports = {
  clickup: {
    apiToken: process.env.CLICKUP_API_TOKEN,
    workspaceId: process.env.CLICKUP_WORKSPACE_ID
  },
  postgres: {
    host: process.env.POSTGRES_HOST || 'host.docker.internal',
    port: parseInt(process.env.POSTGRES_PORT) || 5432,
    database: process.env.POSTGRES_DB || 'postgres',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD
  }
}; 