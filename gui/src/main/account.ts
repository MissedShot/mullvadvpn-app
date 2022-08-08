import {
  AccountToken,
  DeviceEvent,
  DeviceState,
  IAccountData,
  IDeviceRemoval,
  TunnelState,
} from '../shared/daemon-rpc-types';
import { messages } from '../shared/gettext';
import log from '../shared/logging';
import {
  AccountExpiredNotificationProvider,
  CloseToAccountExpiryNotificationProvider,
  SystemNotification,
} from '../shared/notifications/notification';
import { Scheduler } from '../shared/scheduler';
import AccountDataCache from './account-data-cache';
import { DaemonRpc } from './daemon-rpc';
import { InvalidAccountError } from './errors';
import { IpcMainEventChannel } from './ipc-event-channel';

export interface AccountDelegate {
  notify(notification: SystemNotification): void;
  getTunnelState(): TunnelState;
  getLocale(): string;
  isPerformingPostUpgradeCheck(): boolean;
  performPostUpgradeCheck(): void;
  setTrayContextMenu(): void;
}

export default class Account {
  private accountDataValue?: IAccountData = undefined;
  private accountHistoryValue?: AccountToken = undefined;
  private accountExpiryNotificationScheduler = new Scheduler();
  private accountDataCache = new AccountDataCache(
    (accountToken) => {
      return this.daemonRpc.getAccountData(accountToken);
    },
    (accountData) => {
      this.accountDataValue = accountData;

      IpcMainEventChannel.account.notify?.(this.accountData);

      this.handleAccountExpiry();
    },
  );

  private deviceStateValue?: DeviceState;

  public constructor(private delegate: AccountDelegate, private daemonRpc: DaemonRpc) {}

  public get accountData() {
    return this.accountDataValue;
  }

  public get accountHistory() {
    return this.accountHistoryValue;
  }

  public get deviceState() {
    return this.deviceStateValue;
  }

  public registerIpcListeners() {
    IpcMainEventChannel.account.handleCreate(() => this.createNewAccount());
    IpcMainEventChannel.account.handleLogin((token: AccountToken) => this.login(token));
    IpcMainEventChannel.account.handleLogout(() => this.logout());
    IpcMainEventChannel.account.handleGetWwwAuthToken(() => this.daemonRpc.getWwwAuthToken());
    IpcMainEventChannel.account.handleSubmitVoucher(async (voucherCode: string) => {
      const currentAccountToken = this.getAccountToken();
      const response = await this.daemonRpc.submitVoucher(voucherCode);

      if (currentAccountToken) {
        this.accountDataCache.handleVoucherResponse(currentAccountToken, response);
      }

      return response;
    });
    IpcMainEventChannel.account.handleUpdateData(() => this.updateAccountData());

    IpcMainEventChannel.accountHistory.handleClear(async () => {
      await this.daemonRpc.clearAccountHistory();
      void this.updateAccountHistory();
    });

    IpcMainEventChannel.account.handleGetDeviceState(async () => {
      try {
        await this.daemonRpc.updateDevice();
      } catch (e) {
        const error = e as Error;
        log.warn(`Failed to update device info: ${error.message}`);
      }
      return this.daemonRpc.getDevice();
    });
    IpcMainEventChannel.account.handleListDevices((accountToken: AccountToken) => {
      return this.daemonRpc.listDevices(accountToken);
    });
    IpcMainEventChannel.account.handleRemoveDevice((deviceRemoval: IDeviceRemoval) => {
      return this.daemonRpc.removeDevice(deviceRemoval);
    });
  }

  public isLoggedIn(): boolean {
    return this.deviceState?.type === 'logged in';
  }

  public updateAccountData = () => {
    if (this.daemonRpc.isConnected && this.isLoggedIn()) {
      this.accountDataCache.fetch(this.getAccountToken()!);
    }
  };

  public detectStaleAccountExpiry(tunnelState: TunnelState) {
    const hasExpired = !this.accountData || new Date() >= new Date(this.accountData.expiry);

    // It's likely that the account expiry is stale if the daemon managed to establish the tunnel.
    if (tunnelState.state === 'connected' && hasExpired) {
      log.info('Detected the stale account expiry.');
      this.accountDataCache.invalidate();
    }
  }

  public handleDeviceEvent(deviceEvent: DeviceEvent) {
    this.deviceStateValue = deviceEvent.deviceState;

    if (this.delegate.isPerformingPostUpgradeCheck()) {
      void this.delegate.performPostUpgradeCheck();
    }

    switch (deviceEvent.deviceState.type) {
      case 'logged in':
        this.accountDataCache.fetch(deviceEvent.deviceState.accountAndDevice.accountToken);
        break;
      case 'logged out':
      case 'revoked':
        this.accountDataCache.invalidate();
        break;
    }

    void this.updateAccountHistory();
    this.delegate.setTrayContextMenu();

    IpcMainEventChannel.account.notifyDevice?.(deviceEvent);
  }

  public setAccountHistory(accountHistory?: AccountToken) {
    this.accountHistoryValue = accountHistory;

    IpcMainEventChannel.accountHistory.notify?.(accountHistory);
  }

  private async createNewAccount(): Promise<string> {
    try {
      return await this.daemonRpc.createNewAccount();
    } catch (e) {
      const error = e as Error;
      log.error(`Failed to create account: ${error.message}`);
      throw error;
    }
  }

  private async login(accountToken: AccountToken): Promise<void> {
    try {
      await this.daemonRpc.loginAccount(accountToken);
    } catch (e) {
      const error = e as Error;
      log.error(`Failed to login: ${error.message}`);

      if (error instanceof InvalidAccountError) {
        throw Error(messages.gettext('Invalid account number'));
      } else {
        throw error;
      }
    }
  }

  private async logout(): Promise<void> {
    try {
      await this.daemonRpc.logoutAccount();

      this.accountExpiryNotificationScheduler.cancel();
    } catch (e) {
      const error = e as Error;
      log.info(`Failed to logout: ${error.message}`);

      throw error;
    }
  }

  private handleAccountExpiry() {
    if (this.accountData) {
      const expiredNotification = new AccountExpiredNotificationProvider({
        accountExpiry: this.accountData.expiry,
        tunnelState: this.delegate.getTunnelState(),
      });
      const closeToExpiryNotification = new CloseToAccountExpiryNotificationProvider({
        accountExpiry: this.accountData.expiry,
        locale: this.delegate.getLocale(),
      });

      if (expiredNotification.mayDisplay()) {
        this.accountExpiryNotificationScheduler.cancel();
        this.delegate.notify(expiredNotification.getSystemNotification());
      } else if (
        !this.accountExpiryNotificationScheduler.isRunning &&
        closeToExpiryNotification.mayDisplay()
      ) {
        this.delegate.notify(closeToExpiryNotification.getSystemNotification());

        const twelveHours = 12 * 60 * 60 * 1000;
        const remainingMilliseconds = new Date(this.accountData.expiry).getTime() - Date.now();
        const delay = Math.min(twelveHours, remainingMilliseconds);
        this.accountExpiryNotificationScheduler.schedule(() => this.handleAccountExpiry(), delay);
      }
    }
  }

  private async updateAccountHistory(): Promise<void> {
    try {
      this.setAccountHistory(await this.daemonRpc.getAccountHistory());
    } catch (e) {
      const error = e as Error;
      log.error(`Failed to fetch the account history: ${error.message}`);
    }
  }

  private getAccountToken(): AccountToken | undefined {
    return this.deviceState?.type === 'logged in'
      ? this.deviceState.accountAndDevice.accountToken
      : undefined;
  }
}
