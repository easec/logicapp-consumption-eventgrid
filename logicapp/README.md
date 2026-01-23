## Logic App – logicapp.json

This Logic App is a Consumption workflow designed to receive Azure Event Grid events via an Azure Function proxy, evaluate blob tier changes, and send notifications when blobs reach the Hot access tier from Archive access tire.</br>
</br>
File: logicapp/logicapp.json
</br>

## Purpose

The Logic App performs business logic only.</br>

It does not:</br>
<li>Handle Event Grid validation</li>
<li>Expose a public webhook directly to Event Grid</li>
<li>Perform authentication</li>
</br>
Those concerns are intentionally handled by the Function proxy.</br>

## Trigger
When HTTP is called</br>
Trigger type: Request</br>
Input: JSON payload forwarded from the Azure Function</br>
<br>
Payload format:</br>
<li>Either a single event object</li>
<li>Or an array of Event Grid events</li>
</br>
Example payload:</br>
<code>
  [
  {
    "eventType": "Microsoft.Storage.BlobTierChanged",
    "subject": "/blobServices/default/containers/snapshot/blobs/example.txt",
    "data": {
      "accessTier": "Hot",
      "previousTier": "Cool"
    }
  }
]
</code>
</br>

## Core Logic
1️⃣ Normalize Event Body

The Logic App supports both array and non-array payloads using coalesce().

Expression pattern used throughout:
<code>
coalesce(triggerBody()?[0], triggerBody())
</code>
</br>
This ensures compatibility whether:

<li>The Function forwards multiple events</li>
<li>Or a single event</li></br>

2️⃣ Check Blob Access Tier

The Logic App evaluates whether the blob has transitioned to Hot.
<code>
equals(
  coalesce(triggerBody()?[0], triggerBody())?['data']?['accessTier'],
  'Hot'
)
</code>
</br>
✔ True → send email </br>
✖ False → no action</br>
</br>
3️⃣ Send Email Notification (Office 365)

Triggered only when accessTier == Hot.

Email body uses dynamic expressions:
<code>
Blob: @{coalesce(triggerBody()?[0], triggerBody())?['subject']}
Previous tier: @{coalesce(triggerBody()?[0], triggerBody())?['data']?['previousTier']}
Current tier: @{coalesce(triggerBody()?[0], triggerBody())?['data']?['accessTier']}

Ready for the next step.
</code>
</br>

## Outputs

No explicit outputs

Completion of workflow indicates successful processing

HTTP response handled upstream by the Function proxy
</br>
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

## API Connections Used

| Connection |          Purpose         |
|:----------:|:------------------------:|
| office365  | Send email notifications |
</br>

## Validation & Testing
The Logic App is validated indirectly by the pipeline:</br>

<li>Function receives synthetic blob event</li>
<li>Function forwards payload</li>
<li>Logic App executes workflow</li>
<li>Application Insights logs confirm execution</li>
</br>
This avoids fragile Logic App–only tests.
</br>

## Design Decisions 
|        Decision       |           Reason           |
|:---------------------:|:--------------------------:|
| No Event Grid trigger | Consumption limitation     |
| HTTP trigger only     | Controlled ingress         |
| No validation logic   | Separation of concerns     |
| No retry logic        | Event Grid handles retries |
| Minimal actions       | Cost & reliability         |
</br>

