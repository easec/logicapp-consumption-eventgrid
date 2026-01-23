# Logic App (Consumption) + Event Grid + Azure Function (Proxy)

This repository deploys a production-grade Event Grid → Azure Function → Logic App (Consumption) integration using Azure DevOps YAML and ARM templates, with end-to-end validation and Application Insights verification baked into the pipeline.

## Architecture

Azure Storage Account
        |
        |  (BlobCreated / BlobTierChanged)
        ↓
Azure Event Grid
        │
        
Azure Function (eventgrid-proxy)
        │
        │  (HTTP forward)
        
Logic App (Consumption)
        │
        
Office 365 / downstream actions



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
