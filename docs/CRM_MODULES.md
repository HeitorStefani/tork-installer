# Tork CRM - modular product plan

## Product shape

The product should have two installation levels:

- **Kanban Lite**: simple sales/attendance board for customers that only need stages, cards, follow-ups and Chatwoot linking.
- **CRM Modular**: Kanban plus metrics, entities, vertical modules and richer automation.

The installer should expose these as selectable profiles instead of one bloated default install.

## Core modules

### 1. Kanban Lite

- Boards and stages.
- Cards linked to Chatwoot conversations.
- Assignee/avatar sync.
- Follow-up cycle.
- Real-time card movement.
- Simple search and pagination.

### 2. CRM Core

- Contacts and organizations.
- Deals/opportunities.
- Activities: message, call, meeting, note, task.
- Custom fields per account.
- Lost/won reasons.
- Tags and sources.
- Timeline per customer.
- Basic permissions per role.

### 3. Metrics

- Conversion by stage.
- Average time in stage.
- Response time and SLA.
- Follow-up aging.
- Agent performance.
- Source/channel performance.
- Won/lost reasons.
- Revenue forecast when deal value exists.

### 4. Automation

- Rules per stage.
- Follow-up templates.
- Webhook triggers.
- Post-event feedback.
- Calendar integration.
- Chatwoot events.
- n8n handoff endpoints.

## Vertical modules

### Clinic

- Procedure/service requested.
- Appointment date/time.
- Professional/provider.
- Confirmation status.
- No-show and reschedule flow.
- Post-appointment feedback.
- Recall/return reminders.
- Patient document checklist.

Useful metrics:

- Scheduled vs confirmed.
- No-show rate.
- Time to schedule.
- Procedure demand.
- Professional workload.

### Law Office

- Matter/case type.
- Consultation scheduling.
- Deadline tracking.
- Document checklist.
- Hearing/meeting dates.
- Responsible attorney.
- Proposal/contract status.

Useful metrics:

- Leads by case type.
- Consultation conversion.
- Deadline risk.
- Proposal acceptance.
- Revenue by practice area.

### Restaurant

- Reservation/waitlist.
- Event or catering requests.
- Customer preferences.
- Birthday and return campaigns.
- Feedback after visit.
- Coupon/campaign tracking.

Useful metrics:

- Reservations by period.
- No-show/cancel rate.
- Return rate.
- Campaign conversion.
- Average party size.

## Installer profiles

Initial profile names:

- `kanban-lite`
- `crm-core`
- `crm-clinic`
- `crm-law`
- `crm-restaurant`

Each profile should map to:

- enabled modules;
- default board template;
- metric widgets;
- custom fields;
- automation templates;
- optional integrations.

## Technical direction

- Keep a shared core schema.
- Put vertical behavior behind feature flags/profile config.
- Avoid forking the app per vertical.
- Store board templates as data, not hardcoded logic.
- Let the installer choose the profile and write it into the customer environment.

## First implementation step

Before adding vertical modules, extract the current hardcoded board/stage setup into reusable templates:

- `templates/boards/kanban-lite.json`
- `templates/boards/clinic.json`
- `templates/boards/law.json`
- `templates/boards/restaurant.json`

Then the installer can choose the profile without changing source code.
