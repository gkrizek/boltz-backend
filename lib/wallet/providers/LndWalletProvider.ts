import { Transaction } from 'bitcoinjs-lib';
import type Logger from '../../Logger';
import type { IChainClient } from '../../chain/ChainClient';
import type LndClient from '../../lightning/LndClient';
import { AddressType } from '../../proto/lnd/rpc_pb';
import type { SentTransaction, WalletBalance } from './WalletProviderInterface';
import type WalletProviderInterface from './WalletProviderInterface';

class LndWalletProvider implements WalletProviderInterface {
  public readonly symbol: string;

  constructor(
    public logger: Logger,
    public lndClient: LndClient,
    public chainClient: IChainClient,
  ) {
    this.symbol = chainClient.symbol;

    this.logger.info(`Initialized ${this.symbol} LND wallet`);
  }

  public serviceName = (): string => {
    return this.lndClient.serviceName();
  };

  public getBalance = (): Promise<WalletBalance> => {
    return this.lndClient.getWalletBalance();
  };

  public getAddress = async (label: string): Promise<string> => {
    if (label !== '') {
      this.logger.warn(`${this.symbol} LND wallet does not support labels`);
    }

    const response = await this.lndClient.newAddress(
      AddressType.TAPROOT_PUBKEY,
    );
    return response.address;
  };

  public sendToAddress = async (
    address: string,
    amount: number,
    satPerVbyte: number | undefined,
    label: string,
  ): Promise<SentTransaction> => {
    // To avoid weird race conditions (insanely unlikely but still), the start height of the LND transaction list call
    // is queried *before* sending the onchain transaction
    const { blockHeight } = await this.lndClient.getInfo();
    const response = await this.lndClient.sendCoins(
      address,
      amount,
      await this.getFeePerVbyte(satPerVbyte),
      label,
    );

    const txid = response.txid
    // use lndClient getOnchainTransactions(blockheight)
    const { transactionsList } = await this.lndClient.getOnchainTransactions(blockHeight);
    // iterate over the list until we find our txid
    const transaction = transactionsList.find((tx) => tx.txHash === txid);
    // grab the raw transaction
    if (transaction === undefined) {
      this.logger.info(`Could not find the transaction for rebroadcasting`);
      // If we can't find the transaction just try to original version anyway.
      return this.handleLndTransaction(txid, address, blockHeight);
    }
    this.logger.info(`Found the transaction for rebroadcasting, attempting...`);
    const rawTx = transaction.rawTxHex;
    // do chainClient.sendRawTransaction()
    await this.chainClient.sendRawTransaction(rawTx);
    // then let it look it up
    return this.handleLndTransaction(txid, address, blockHeight);
  };

  public sweepWallet = async (
    address: string,
    satPerVbyte: number | undefined,
    label: string,
  ): Promise<SentTransaction> => {
    // See "sendToAddress"
    const { blockHeight } = await this.lndClient.getInfo();
    const response = await this.lndClient.sweepWallet(
      address,
      await this.getFeePerVbyte(satPerVbyte),
      label,
    );

    return this.handleLndTransaction(response.txid, address, blockHeight);
  };

  private handleLndTransaction = async (
    transactionId: string,
    address: string,
    listStartHeight: number,
  ): Promise<SentTransaction> => {
    const rawTransaction =
      await this.chainClient.getRawTransactionVerbose(transactionId);

    let vout = 0;

    for (const output of rawTransaction.vout) {
      if (
        output.scriptPubKey.address === address ||
        (output.scriptPubKey.addresses &&
          output.scriptPubKey.addresses.includes(address))
      ) {
        vout = output.n;
      }
    }

    let fee = 0;

    // To limit the number of onchain transactions LND has to query, the start height is set
    const { transactionsList } =
      await this.lndClient.getOnchainTransactions(listStartHeight);

    for (let i = 0; i < transactionsList.length; i += 1) {
      const transaction = transactionsList[i];

      if (transaction.txHash === transactionId) {
        fee = transaction.totalFees;
        break;
      }
    }

    return {
      fee,
      vout,
      transactionId,

      transaction: Transaction.fromHex(rawTransaction.hex),
    };
  };

  private getFeePerVbyte = async (satPerVbyte?: number) => {
    return satPerVbyte || (await this.chainClient.estimateFee());
  };
}

export default LndWalletProvider;
