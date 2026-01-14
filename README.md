# Logic App Consumption – Event Grid CI/CD

This repository deploys an Azure Logic App (Consumption) triggered by Event Grid,
using Azure DevOps YAML pipelines and ARM templates.

## Architecture
- Logic App workflow (separate from infra)
- API Connections deployed via ARM
- Event Grid subscription deployed after Logic App

## Deployment Order
1. Connections
2. Logic App
3. Event Grid

## Environments
- Dev
- Prod

## Requirements
- Azure DevOps ARM Service Connection
- Contributor access on target Resource Group
