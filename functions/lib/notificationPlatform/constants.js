'use strict';

// TrustyDr Workflow & Notification Platform — Phase 1 shared constants.
// See NOTIFICATION_PLATFORM_PROGRESS.md at the ecosystem root for the full
// architecture writeup this implements.

const PRIORITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low',
  SILENT: 'silent',
};

// Only PUSH is actually dispatched today; IN_APP delivery is implicit --
// writing the notification document IS the in-app channel, so it never
// appears in a stage's own `channels` list (see notificationEngine.js). The
// remaining names exist now so a future channel is an additive dispatch
// function, never a schema/engine change.
const CHANNEL = {
  PUSH: 'push',
  IN_APP: 'inApp',
  EMAIL: 'email',
  SMS: 'sms',
  WHATSAPP: 'whatsapp',
  WEBHOOK: 'webhook',
};

// Shared action-key catalog so client UIs render a known, finite set of
// action buttons instead of free text. Add new keys here as new workflows
// need them; the client resolves each key to its own button label/icon/handler.
const ACTION = {
  VIEW_ORDER: 'view_order',
  TRACK_DELIVERY: 'track_delivery',
  REQUEST_REFILL: 'request_refill',
  JOIN_APPOINTMENT: 'join_appointment',
  PAY_NOW: 'pay_now',
  OPEN_CHAT: 'open_chat',
};

module.exports = { PRIORITY, CHANNEL, ACTION };
