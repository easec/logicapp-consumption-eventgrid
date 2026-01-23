# Azure Function – eventgrid-proxy

This Azure Function acts as a secure webhook proxy between Azure Event Grid and a Logic App (Consumption).

It solves three problems:

<li>Event Grid webhook validation</li>
<li>Safe forwarding to Logic App HTTP trigger</li>
<li>Observability via Application Insights</li>
</br>
File: functionapp/eventgrid-proxy/index.js
</br>

## Responsibilities

|  Responsibility  |               Description               |
|:----------------:|:---------------------------------------:|
| Webhook endpoint | Receives Event Grid POST requests       |
| Validation       | Responds to SubscriptionValidationEvent |
| Forwarding       | Sends real events to Logic App          |
| Telemetry        | Logs success/failure to App Insights    |
| Security         | Does not expose Logic App publicly      |
|                  |                                         |

## Supported Event Types

<i>Subscription validation</i></br>
<code>
{
  "eventType": "Microsoft.EventGrid.SubscriptionValidationEvent",
  "data": {
    "validationCode": "abc123"
  }
}
</code>

<i>Response</i> </br>
<code>
{
  "validationResponse": "abc123"
}
</code>
</br>
This enables Event Grid to activate the subscription. </br>

## Storage events

<li>Microsoft.Storage.BlobCreated</li>
<li>Microsoft.Storage.BlobTierChanged</li>
</br>
These are forwarded to the Logic App unchanged.</br>

## Environment Variables

|  Responsibility  |               Description               |
|:----------------:|:---------------------------------------:|
| Webhook endpoint | Receives Event Grid POST requests       |
| Validation       | Responds to SubscriptionValidationEvent |
| Forwarding       | Sends real events to Logic App          |
| Telemetry        | Logs success/failure to App Insights    |
| Security         | Does not expose Logic App publicly      |
|                  |                                         |

## Processing Logic (Step-by-Step)

1️⃣ Parse request body </br>
Event Grid always sends an array of events.</br>
<code>
const events = Array.isArray(req.body) ? req.body : [];
</code>
</br>
2️⃣ Handle subscription validation </br>
Event Grid sends this once per subscription.</br>
<code>
if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
  context.res = {
    status: 200,
    body: { validationResponse: event.data.validationCode }
  };
  return;
}
</code>
</br>
✔ Required for Event Grid</br>
✔ Must return HTTP 200</br>
</br>
3️⃣ Forward real events to Logic App</br>
<code>
const response = await fetch(process.env.LOGICAPP_CALLBACK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(events)
});
</code>
</br>
<li>HTTPS only</li>
<li>Signed callback URL</li>
<li>No secrets in payload</li>
</br>
4️⃣ Log forwarding result </br>
Logs appear in Application Insights. </br>
<code>
context.log(`Forwarded to Logic App. Status: ${response.status}`);
</code>
</br>
Used by the pipeline’s KQL verification step.</br>
</br>
5️⃣ Return response to Event Grid</br>
Event Grid requires a 2xx response.</br>
<code>
  context.res = {
  status: 200,
  body: { ok: true, forwardedStatus: response.status }
};
</code>
</br>

## End-to-End Validation
</br>
This function is verified in CI/CD by:</br>
1. Posting a SubscriptionValidationEvent </br>
2. Posting a synthetic BlobTierChanged event</br>
3. Querying Application Insights logs via REST (KQL)</br>
<br>
The pipeline fails if:</br>
<li>Validation fails</li>
<li>Forwarding fails</li>
<li>Logs are missing</li>
</br>

## Security Model
|  Responsibility  |               Description               |
|:----------------:|:---------------------------------------:|
| Webhook endpoint | Receives Event Grid POST requests       |
| Validation       | Responds to SubscriptionValidationEvent |
| Forwarding       | Sends real events to Logic App          |
| Telemetry        | Logs success/failure to App Insights    |
| Security         | Does not expose Logic App publicly      |
|                  |                                         |
</br>




