# Logic App (Consumption) + Event Grid + Azure Function (Proxy)

This repository deploys a production-grade Event Grid → Azure Function → Logic App (Consumption) integration using Azure DevOps YAML and ARM templates, with end-to-end validation and Application Insights verification baked into the pipeline.

## Architecture

Azure Storage Account <br />
        | <br />
        |  (BlobCreated / BlobTierChanged) <br />
        ↓ <br />
Azure Event Grid <br />
        │ <br />
        ↓ <br />
Azure Function (eventgrid-proxy) <br />
        │ <br />
        │  (HTTP forward)  <br />
        ↓ <br />
Logic App (Consumption)  <br />
        │ <br />
        ↓ <br />
Office 365 / downstream actions  <br />

## Why a Function proxy?

Logic Apps (Consumption) do not support Event Grid webhooks directly

Function handles:

Event Grid validation handshake

Payload normalization

Secure forwarding to Logic App

Observability via Application Insights

## What the Pipeline Deploys

|        Component        |                       Description                      |
|:-----------------------:|:------------------------------------------------------:|
| Logic App (Consumption) | HTTP trigger, conditional handling, email notification |
| API Connections         | Office365 + Azure Event Grid                           |
| Azure Function App      | Node.js Event Grid webhook proxy                       |
| Event Grid Subscription | BlobCreated + BlobTierChanged                          |
| Application Insights    | Telemetry & validation                                 |
| Pre-flight Checks       | End-to-end verification via REST                       |

## CI/CD Pipeline Overview

File: create_logic_app.yml

Pipeline Stages

Validate ARM JSON

Deploy API Connections

Deploy Logic App

Deploy Function App infrastructure

Deploy Function code (ZIP)

Pre-flight end-to-end verification

Create Event Grid subscription

## Pre-Flight End-to-End Validation

The pipeline fails fast if anything is misconfigured.

✔ Function validation

Sends SubscriptionValidationEvent

Verifies HTTP 200 + validationResponse

✔ Blob event test

Simulates BlobTierChanged

Verifies:

HTTP 200

{ "ok": true }

Forwarding status (202)

✔ Application Insights verification

Queries App Insights via REST (KQL)

Confirms forwarding logs exist in last 15 minutes

## Repository Structure
<code>
.
├── create_logic_app.yml
├── infra/
│   ├── functionapp.json
│   ├── connections.json
│   └── parameters/
│       ├── functionapp.dev.json
│       └── connections.dev.json
├── logicapp/
│   ├── logicapp.json
│   └── parameters/
│       └── logicapp.dev.json
├── functionapp/
│   ├── eventgrid-proxy/
│   │   ├── index.js
│   │   └── function.json
│   └── host.json
└── README.md
</code>

## Azure DevOps Requirements
Service Connection <br />

Type: Azure Resource Manager <br />

Auth: App Registration (Automatic)  <br />

Permissions:  <br />

Contributor on resource group  <br />

EventGrid EventSubscription write  <br />

## Variable Group (variable_iScaleArchive)

Required variables:

|         Name        |              Purpose              |
|:-------------------:|:---------------------------------:|
| resourceGroupName   | Target RG                         |
| rgLocation          | Region                            |
| storageAccount      | Storage account name              |
| logicAppCallbackUrl | Logic App HTTP trigger URL        |
| triggerName         | Logic App trigger                 |
| …                   | VM / snapshot variables (if used) |

## Function Behavior (eventgrid-proxy)

<i>Subscription validation</i>
<code>
{
  "eventType": "Microsoft.EventGrid.SubscriptionValidationEvent",
  "data": { "validationCode": "abc123" }
}
</code>

Returns:
<code>
{ "validationResponse": "abc123" }

</code>

<i>Storage events</i> </br>
<li>Forwards payload to Logic App</li>
<li>Returns { "ok": true }</li>
<li>Logs forwarding status to App Insights </li>

## Observability
All forwarding operations are logged to Application Insights:</br>
Example KQL:
<code>
traces
| where message contains "Forwarded to Logic App"
| order by timestamp desc
</code>
Used by pipeline to assert correctness. </br>

## Security Notes

<li>Logic App protected via signed callback URL</li>
<li>Function uses Managed Identity</li>
<li>No secrets stored in repo</li>
<li>All sensitive values sourced from Variable Groups</li>

