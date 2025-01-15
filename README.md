# ClickUp Data Sync Service

A Node.js service that works alongside Airbyte to provide comprehensive ClickUp data synchronization. While Airbyte handles the core data replication twice daily, this service fills critical gaps by managing custom fields, relationships, and real-time updates.

## Overview

This service:
- Syncs custom fields from ClickUp tasks
- Tracks field value changes over time
- Maintains task relationships
- Works in conjunction with Airbyte for base task data

## Architecture Overview

This service implements a dual-sync strategy:

1. **Base Data Sync (Airbyte)**
   - Runs twice daily via [Airbyte's ClickUp connector](https://docs.airbyte.com/integrations/sources/clickup-api)
   - Handles core task data and basic fields
   - Maintains _airbyte_raw_id and other Airbyte-specific columns

2. **Extended Data Sync (This Service)**
   - Manages custom fields and relationships
   - Tracks field value changes over time
   - Handles real-time updates via webhooks
   - Works only with existing tasks (waiting for Airbyte to create base records)

## Prerequisites

- Node.js 14+
- PostgreSQL 12+
- Airbyte setup with ClickUp connector
- ClickUp API access token
- Docker and Docker Compose (optional)

## Installation

1. Clone the repository:
```bash
git clone [repository-url]
cd clickup-sync
```

2. Install dependencies:
```bash
npm install
```

3. Create .env file:
```env
# Database (same database used by Airbyte)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=clickup_sync
POSTGRES_USER=your_user
POSTGRES_PASSWORD=your_password

# ClickUp
CLICKUP_API_TOKEN=your_api_token
CLICKUP_WORKSPACE_ID=your_workspace_id
CLICKUP_TEST_SPACE_ID=your_test_space_id

# App
PORT=3000
NODE_ENV=development
```

## Usage

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

### Docker Deployment
```bash
docker-compose up -d
```

## Database Schema

The service shares the database with Airbyte and extends it with additional tables:

- `clickup_task`: Core task data (managed by Airbyte)
  - Contains _airbyte_raw_id and _airbyte_extracted_at columns
  - Updated twice daily by Airbyte

- `field_changes`: Historical tracking of field value changes
  - Managed by this service
  - Tracks all field modifications with timestamps

## Project Structure
```
├── src/
│   ├── config/         # Configuration files
│   ├── db/            # Database operations
│   ├── services/      # Business logic
│   └── index.js       # Application entry point
├── docker-compose.yml
├── package.json
└── README.md
```

## Known Issues & TODOs

### Known Issues

1. **Airbyte Sync Timing**
   - Race condition possible when updating tasks during Airbyte sync
   - Some field updates may be lost if they occur exactly during Airbyte's sync window
   - TODO: Implement sync window detection and retry mechanism

2. **Custom Field Handling**
   - Array-type custom fields only store first value
   - Emoji in field names can cause mapping issues
   - TODO: Improve array field storage and emoji handling

3. **Webhook Processing**
   - Webhook payload sometimes missing full task details
   - Occasional duplicate webhook events
   - TODO: Implement webhook deduplication and retry logic

4. **Database Constraints**
   - _airbyte_raw_id and _airbyte_extracted_at constraints can cause update failures
   - Need better handling of Airbyte-managed columns
   - TODO: Add proper error handling for Airbyte column constraints

### Priority Tasks

1. High Priority
   - [ ] Fix Airbyte column constraint issues
   - [ ] Implement webhook deduplication
   - [ ] Add sync window detection

2. Medium Priority
   - [ ] Improve array field handling
   - [ ] Add monitoring and metrics
   - [ ] Create admin interface

3. Low Priority
   - [ ] Optimize database indexes
   - [ ] Add caching layer
   - [ ] Enhance documentation

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

When working on issues:
1. Reference the issue number in commits
2. Add tests for the fix
3. Update documentation
4. Consider Airbyte's sync schedule

## License

[Your chosen license]

## References

- [Airbyte ClickUp Source Documentation](https://docs.airbyte.com/integrations/sources/clickup-api) 