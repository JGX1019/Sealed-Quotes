import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  open_rfq(context: __compactRuntime.CircuitContext<PS>, budget_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  submit_bid(context: __compactRuntime.CircuitContext<PS>, price_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  close_rfq(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  open_rfq(context: __compactRuntime.CircuitContext<PS>, budget_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  submit_bid(context: __compactRuntime.CircuitContext<PS>, price_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  close_rfq(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  open_rfq(context: __compactRuntime.CircuitContext<PS>, budget_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  submit_bid(context: __compactRuntime.CircuitContext<PS>, price_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  close_rfq(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly budget_max: bigint;
  readonly bid_count: bigint;
  readonly qualifying_count: bigint;
  readonly is_open: boolean;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
