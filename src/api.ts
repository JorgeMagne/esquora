import { useQuery } from '@tanstack/react-query'
import type { AccountKind, Role } from './model.ts'

export type User = { id: string; name: string; email: string; kind: AccountKind | null; orgName: string | null; orgNit: string | null; phone: string | null; publicKey: string; walletStatus: string; esquoraVerifier?: boolean }
export type Asset = { code: string; issuer: string }
export type Config = { explorerUrl: string; network: string; asset: Asset; feeBps: number; bobPerUsdc: number; appUrl?: string; testMode?: boolean }
export type Session = { user: User | null; config: Config }
export type Party = { id: string; name: string; orgName: string | null; publicKey?: string }
export type ResolutionMode = 'pending' | 'external' | 'esquora'
export type ResolutionTerms = { version: string; title: string; clauses: string[] }
export type FileInfo = { id: string; name: string; sha256: string; size: number; mime: string }
export type Evidence = { reqKey: string; file: FileInfo | null }
export type Totals = { held: number; released: number; refunded: number; fees?: number }
export type Project = { id: string; name: string; city: string; address: string; description?: string; unitsTotal?: number; deliveryDate?: string; stats: Totals & { operations: number } }
export type ProjectDetail = Project & { docs: (Evidence & { id: string })[]; operations: OperationSummary[] }
export type Requirement = { key: string; label: string }
export type TrancheSummary = { idx: number; title: string; amount: number; status: string; dueAt: string; overdue: boolean; feeEstimate?: number }
export type ActionKind = 'evidence' | 'approve' | 'release' | 'refund' | 'dispute' | 'resolve' | 'withdraw' | 'probe'
export type Receipt = { status: 'pending' | 'confirmed' | 'failed'; hash?: string; error?: string | null; ledger?: number | null }
export type Armed = Partial<Receipt> & { id?: string; xdr?: string; expiresAt?: number | string | null }
export type ActionInput = { kind: ActionKind; trancheId?: string; opId?: string; items?: { reqKey: string; fileId: string }[]; note?: string; reason?: string; toBuyer?: number; toSeller?: number; amount?: number; bank?: string; account?: string; holder?: string; ledger?: boolean; instructionId?: string }
export type Tranche = TrancheSummary & {
  id: string; condition: string; requirements: Requirement[]; feeEstimate: number; evidence: Evidence[];
  evidenceNote: string | null; objection: string | null; refundRequestedAt: string | null; refundWindowPassed: boolean;
  evidenceHistory?: { txHash: string | null; at: string; files: Evidence[] }[];
  refundResponse?: 'accepted' | 'rejected' | null; refundResponseDueAt?: string | null; refundResponseReason?: string | null;
  disputeReason: string | null; disputeByRole: Role | null; txHash: string | null; toBuyer: number | null; toSeller: number | null;
  fee?: number | null; settledAt?: string | null; pendingAction?: (Receipt & { id: string; kind: ActionKind }) | null;
}
export type Activity = { id: number; type: string; data?: Record<string, unknown>; txHash: string | null; at: string; actorRole: Role | null }
export type OperationSummary = {
  id: string; code: string; status: string; role: Role; project: Pick<Project, 'id' | 'name' | 'city' | 'address'>;
  unit: string; unitDetail?: string | null; price: number; deposit: number; buyerName: string; sellerName?: string; totals: Totals;
  todo: string | null; tranches: TrancheSummary[]; createdAt: string;
}
export type Operation = Omit<OperationSummary, 'tranches'> & {
  feeBps: number; refundResponseHours: number; seller: Party; buyer: Party | null; buyerEmail: string;
  resolutionMode: ResolutionMode; arbiter: Party | null; arbiterEmail: string | null; arbiterInviteToken: string | null;
  resolverReady: boolean; resolutionTerms: ResolutionTerms | null;
  contract: FileInfo | null; contractSha256: string | null; termsDigest: string;
  sellerSig: string | null; buyerSig: string | null; inviteToken: string | null; declineReason: string | null;
  deploymentError?: string | null;
  escrow: { account: string; contractId?: string; txHash: string | null } | null;
  depositOrder: DepositOrder | null; tranches: Tranche[]; events: Activity[];
}
export type DepositOrder = {
  id: string; opId?: string; amount: number; rate: number; amountBob: number; reference: string;
  status: string; expiresAt: string; expired?: boolean; error?: string | null; txHash?: string | null;
  beneficiary?: string; concept?: string; paymentUrl?: string;
}
export type Invitation = {
  opId: string; code: string; project: Pick<Project, 'name' | 'city'>; unit: string; unitDetail?: string | null; deposit: number; price: number;
  sellerName: string; claimed: boolean; mine: boolean; status: string;
}
export type ResolverInvitation = { mine: false } | {
  opId: string; code: string; unit: string; project: Pick<Project, 'name' | 'city'>; sellerName: string;
  status: 'pending' | 'accepted'; mine: true;
}
export type Wallet = {
  usdc: number; exists: boolean;
  movements: { id: string; incoming: boolean; cents: number; at: string; txHash: string; label: string; opId: string | null }[];
  withdrawals: { id: string; amount: number; rate: number; amountBob: number; bank: string; account: string; holder: string; status: string; txHash: string | null; createdAt: string }[];
}
export type Notification = Activity & { opId: string; code: string; unit: string; unread: boolean }
export type Verification = {
  contractId: string | null; roles: Record<string, unknown>; held: number; asset: Asset; contractSha256: string | null; termsDigest: string;
  explorerUrl?: string; transactions: (Receipt & { id?: string; kind?: string; confirmedAt?: string })[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api' + path, { ...init, credentials: 'same-origin' })
  } catch (error) {
    if (init?.signal?.aborted) throw error
    throw new Error('No pudimos conectar. Revisa tu conexión y vuelve a intentar.')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) {
    throw new ApiError(typeof data?.error === 'string' ? data.error : 'No pudimos completar la solicitud. Vuelve a intentar.', response.status)
  }
  return data as T
}

export function write<T>(path: string, data?: unknown, method = 'POST') {
  return api<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) })
}

export function read<T>(path: string) {
  return useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api<T>(path, { signal }),
  })
}

export function useSession() {
  return read<Session>('/me')
}

export function readOperation(id: string) {
  return useQuery({
    queryKey: ['/ops/' + id],
    queryFn: ({ signal }) => api<Operation>('/ops/' + id, { signal }),
    refetchInterval: (query) => {
      const operation = query.state.data
      if (!operation) return false
      if (operation.status === 'deploying' || operation.depositOrder?.status === 'paid' ||
        operation.tranches.some((tranche) => tranche.pendingAction?.status === 'pending')) return 3500
      if (operation.status === 'draft' && operation.role === 'seller' && operation.resolutionMode === 'external' && !operation.resolverReady) return 6000
      return false
    },
  })
}

export function uploadFile(file: File) {
  const body = new FormData()
  body.set('file', file)
  return api<FileInfo>('/files', { method: 'POST', body })
}

export const fileLink = (file: FileInfo) => '/api/files/' + encodeURIComponent(file.id) + '?descargar=1'
export const operationPath = (id: string) => '/operaciones/' + encodeURIComponent(id)
export const conditionPath = (id: string, trancheId: string) => operationPath(id) + '/condiciones/' + encodeURIComponent(trancheId)
export const invitationPath = (token: string) => '/invitacion/' + encodeURIComponent(token)
export const resolverInvitationPath = (token: string) => '/tercero/' + encodeURIComponent(token)
export const projectPath = (id: string) => '/proyectos/' + encodeURIComponent(id)
export const paymentPath = (id: string) => '/pago/' + encodeURIComponent(id)
