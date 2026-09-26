export class LocalNotificationProvider {
  constructor(logger = console) { this.logger = logger; }
  async send(notification) { this.logger.info('[local-notification]', JSON.stringify(notification)); return { delivered: true, driver: 'local' }; }
}

export function createNotificationProvider() { return new LocalNotificationProvider(); }
