import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { netAfterFees } from '../shared/fees.ts'
import {
  invitationPath, operationPath, projectPath, read, resolverInvitationPath, uploadFile, useSession, write, type Invitation, type Operation,
  type OperationSummary, type Project, type ProjectDetail, type ResolutionMode, type ResolverInvitation, type User,
} from './api.ts'
import { amountInCents, conditions, formatDate, money, operationLabels } from './model.ts'
import { AccessPlan } from './plans.tsx'
import { amountsForDraft, buildDraftConditions, draftAmount, draftRequirement, emptyCondition, MAX_CONDITIONS, MAX_REQUIREMENTS, moveCondition, preventaTemplate, type DraftCondition } from './preventa-draft.ts'
import { ResolverOptions } from './resolver-options.tsx'
import { ActionLink, Amount, Back, Empty, Feedback, Field, FileRow, Loading, RowLink, Submit, Title, TotalsStrip, useWork } from './ui.tsx'

export function Home({ user }: { user: User }) {
  if (user.kind === 'developer') return <DeveloperHome />
  return <OperationList user={user} />
}

function OperationList({ user }: { user: User }) {
  const list = read<OperationSummary[]>('/ops')
  const arbiter = user.kind === 'arbiter'
  if (list.isPending) return <Loading>Buscando tus operaciones…</Loading>
  if (list.isError) return <Feedback error={list.error} onRetry={() => void list.refetch()} />
  if (list.data.length === 1 && !arbiter) return <Navigate to={operationPath(list.data[0].id)} replace />
  return <>
    <Title>{arbiter ? 'Casos' : 'Mis compras'}</Title>
    {list.data.length ? <div className="workspace-plan">
      <div className="row-list">{list.data.map((operation) => <OperationRow key={operation.id} operation={operation} />)}</div>
      <AccessPlan />
    </div> :
      <div className="empty-with-plan">
        <Empty title={arbiter ? 'No tienes casos pendientes' : 'Todavía no tienes una compra'}>
          {arbiter ? 'Cuando te corresponda intervenir, encontrarás aquí el expediente.' : 'Abre el enlace que te envíe tu desarrollador para revisar el acuerdo de preventa.'}
        </Empty><AccessPlan />
      </div>}
  </>
}

function DeveloperHome() {
  const projects = read<Project[]>('/projects')
  const operations = read<OperationSummary[]>('/ops')
  const platformFee = useSession().data?.config.feeBps ?? 90
  const totals = projects.data?.reduce((result, project) => ({
    held: result.held + project.stats.held,
    released: result.released + project.stats.released,
    refunded: result.refunded + project.stats.refunded,
  }), { held: 0, released: 0, refunded: 0 })
  const actions = operations.data?.filter((operation) => operation.todo).slice(0, 8)
  const receivable = operations.data?.reduce((total, operation) => total + operation.tranches.filter((tranche) => tranche.status === 'approved')
    .reduce((approved, tranche) => approved + (tranche.feeEstimate === undefined ?
      netAfterFees(tranche.amount, platformFee) : tranche.amount - tranche.feeEstimate), 0), 0)
  return <>
    <Title action={<Link className="button primary" to="/proyectos/nuevo"><Plus size={18} aria-hidden="true" />Nuevo proyecto</Link>}>Proyectos</Title>
    {projects.isPending && <Loading>Cargando proyectos…</Loading>}
    <Feedback error={projects.error} onRetry={projects.isError ? () => void projects.refetch() : undefined} />
    {projects.data && totals && <>
      <div className="workspace-plan">
        <div>
          <TotalsStrip totals={totals} />
          {receivable !== undefined && <p className="receivable"><strong>{money(receivable)}</strong> en condiciones confirmadas por cobrar</p>}
        </div>
        <AccessPlan />
      </div>
      <div className="two-column workspace-columns">
        <section className="section">
          <h2>Mis proyectos</h2>
          {projects.data.length ? projects.data.map((project) => <RowLink key={project.id} to={projectPath(project.id)} title={project.name}
            detail={project.city + ' · ' + project.stats.operations + (project.stats.operations === 1 ? ' operación' : ' operaciones')}
            end={money(project.stats.held)} />) :
            <Empty title="Aún no agregaste proyectos">Crea el proyecto y adjunta los documentos que quieras reutilizar para varias unidades.</Empty>}
        </section>
        <section className="section">
          <h2>Acciones pendientes</h2>
          {operations.isPending && <Loading />}
          <Feedback error={operations.error} onRetry={operations.isError ? () => void operations.refetch() : undefined} />
          {actions?.length ? actions.map((operation) => <OperationRow key={operation.id} operation={operation} />) : actions &&
            <p className="muted">Estás al día con tus operaciones.</p>}
        </section>
      </div>
    </>}
  </>
}

function OperationRow({ operation }: { operation: OperationSummary }) {
  return <RowLink to={operationPath(operation.id)}
    title={operation.unit + ' · ' + operation.project.name}
    detail={operation.todo ?? operationLabels[operation.status] ?? 'Operación'}
    end={money(operation.totals.held)} />
}

export function ProjectNew() {
  const task = useWork()
  const navigate = useNavigate()
  const query = useQueryClient()
  return <>
    <Back to="/">Proyectos</Back>
    <Title>Nuevo proyecto</Title>
    <form className="section form-grid" onSubmit={task.submit(async (data) => {
      const values = Object.fromEntries(data)
      const project = await write<Project>('/projects', { ...values, unitsTotal: values.unitsTotal ? Number(values.unitsTotal) : undefined })
      await query.invalidateQueries({ queryKey: ['/projects'] })
      navigate(projectPath(project.id))
    })}>
      <Field label="Nombre del proyecto"><input name="name" required maxLength={120} /></Field>
      <Field label="Ciudad"><input name="city" required maxLength={80} /></Field>
      <Field label="Dirección" wide><input name="address" required maxLength={200} /></Field>
      <Field label="Unidades (opcional)"><input name="unitsTotal" type="number" min={1} step={1} /></Field>
      <Field label="Entrega estimada (opcional)"><input name="deliveryDate" type="date" /></Field>
      <Field label="Descripción (opcional)" wide><textarea name="description" maxLength={1000} /></Field>
      <div className="field-wide"><Feedback error={task.error} /><Submit waiting={task.busy}>Crear proyecto</Submit></div>
    </form>
  </>
}

export function ProjectPage() {
  const { id = '' } = useParams()
  const project = read<ProjectDetail>('/projects/' + id)
  const query = useQueryClient()
  const task = useWork()
  const [removing, setRemoving] = useState<string | null>(null)
  if (project.isPending) return <Loading>Abriendo el proyecto…</Loading>
  if (project.isError) return <Feedback error={project.error} onRetry={() => void project.refetch()} />
  const { name, city, address, stats, operations, docs, description, deliveryDate } = project.data
  const reusable = [...conditions[0].requirements.slice(1), ...conditions[1].requirements]
  const path = '/projects/' + id + '/docs'

  return <>
    <Back to="/">Proyectos</Back>
    <Title detail={city + ' · ' + address} action={<ActionLink to={projectPath(id) + '/nueva-operacion'}>Nueva operación</ActionLink>}>{name}</Title>
    <TotalsStrip totals={stats} />
    <div className="two-column workspace-columns">
      <div>
        <section className="section">
          <h2>Operaciones por unidad</h2>
          {operations.length ? operations.map((operation) => <OperationRow key={operation.id} operation={operation} />) :
            <Empty title="Todavía no hay operaciones">Crea un acuerdo de preventa para la primera unidad.</Empty>}
        </section>
        {(description || deliveryDate) && <section className="section">
          <h2>Datos del proyecto</h2>
          {description && <p>{description}</p>}{deliveryDate && <p>Entrega estimada · {formatDate(deliveryDate)}</p>}
        </section>}
      </div>
      <section className="section">
        <h2>Documentos del proyecto</h2>
        <p className="muted">Podrás reutilizarlos al presentar una condición de este proyecto.</p>
        {docs.map((doc) => doc.file && <div className="document-line" key={doc.id}>
          <FileRow file={doc.file} label={reusable.find((item) => item.key === doc.reqKey)?.label ?? doc.file.name} detail={doc.file.name} />
          <button className="icon-button" type="button" disabled={task.busy} aria-label={'Quitar ' + doc.file.name} onClick={() => setRemoving(doc.id)}>
            <Trash2 size={17} aria-hidden="true" />
          </button>
        </div>)}
        {removing && <div className="stack">
          <p>¿Quitar el documento del proyecto?</p><div className="button-row">
            <button className="button secondary" type="button" disabled={task.busy} onClick={() => setRemoving(null)}>Conservar</button>
            <button className="button secondary" type="button" disabled={task.busy} onClick={() => void task.run(async () => {
              await write(path + '/' + removing, undefined, 'DELETE')
              setRemoving(null)
              await query.invalidateQueries({ queryKey: ['/projects/' + id] })
            })}>Quitar documento</button>
          </div>
        </div>}
        <form className="stack" onSubmit={task.submit(async (data) => {
          const file = data.get('file')
          if (!(file instanceof File) || !file.size) throw new Error('Selecciona el documento.')
          const uploaded = await uploadFile(file)
          await write(path, { reqKey: data.get('reqKey'), fileId: uploaded.id })
          await query.invalidateQueries({ queryKey: ['/projects/' + id] })
        })}>
          <Field label="Tipo de documento"><select name="reqKey" required>
            {reusable.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
          </select></Field>
          <Field label="Adjuntar archivo"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp" required /></Field>
          <Feedback error={task.error} />
          <Submit waiting={task.busy}>Guardar documento</Submit>
        </form>
      </section>
    </div>
  </>
}

export function OperationNew() {
  const { id = '' } = useParams()
  const project = read<ProjectDetail>('/projects/' + id)
  const user = useSession().data?.user
  const task = useWork()
  const navigate = useNavigate()
  const query = useQueryClient()
  const [startingPoint, setStartingPoint] = useState<'template' | 'blank'>('template')
  const [drafts, setDrafts] = useState(() => ({ template: preventaTemplate(), blank: [emptyCondition()] }))
  const [deposit, setDeposit] = useState('')
  const [resolutionMode, setResolutionMode] = useState<ResolutionMode>('pending')
  const [arbiterEmail, setArbiterEmail] = useState('')
  const nextPath = projectPath(id) + '/nueva-operacion'

  if (project.isPending) return <Loading>Preparando el acuerdo…</Loading>
  if (project.isError) return <Feedback error={project.error} onRetry={() => void project.refetch()} />
  if (user?.walletStatus !== 'active') return <>
    <Back to={projectPath(id)}>Volver al proyecto</Back>
    <Title>Nueva operación</Title>
    <p>Activa tu cuenta para crear una operación de preventa.</p>
    <ActionLink to={'/cuenta?volver=' + encodeURIComponent(nextPath)}>Activar mi cuenta</ActionLink>
  </>

  return <>
    <Back to={projectPath(id)}>Volver al proyecto</Back>
    <Title detail={project.data.name}>Nueva operación</Title>
    <form className="operation-form" onSubmit={task.submit(async (data) => {
      const initial = amountInCents(deposit)
      const price = amountInCents(String(data.get('price')))
      if (initial > price) throw new Error('La cuota inicial debe ser menor o igual al precio del inmueble.')
      const tranches = buildDraftConditions(drafts[startingPoint], initial)
      const contract = data.get('contract')
      if (resolutionMode === 'external' && arbiterEmail.trim().toLowerCase() === String(data.get('buyerEmail')).trim().toLowerCase())
        throw new Error('El comprador y el tercero designado deben usar correos diferentes.')
      const file = contract instanceof File && contract.size > 0 ? await uploadFile(contract) : null
      const operation = await write<Operation>('/ops', {
        projectId: id, unit: data.get('unit'), unitDetail: data.get('unitDetail'), price, deposit: initial, buyerName: data.get('buyerName'),
        buyerEmail: data.get('buyerEmail'), resolutionMode,
        ...(resolutionMode === 'external' && { arbiterEmail: arbiterEmail.trim() }),
        ...(file && { contractFileId: file.id }),
        refundResponseHours: Number(data.get('refundResponse')) / (data.get('refundUnit') === 'minutes' ? 60 : 1), tranches,
      })
      query.setQueryData(['/ops/' + operation.id], operation)
      await query.invalidateQueries({ queryKey: ['/projects/' + id] })
      navigate(operationPath(operation.id))
    })}>
      <section className="section form-grid">
        <h2 className="field-wide">Inmueble y comprador</h2>
        <Field label="Unidad"><input name="unit" required maxLength={80} placeholder="A-302" /></Field>
        <Field label="Tipo y piso de la unidad (opcional)"><input name="unitDetail" maxLength={120} placeholder="Departamento, piso 3" /></Field>
        <Field label="Nombre del comprador"><input name="buyerName" required maxLength={120} /></Field>
        <Field label="Correo del comprador"><input name="buyerEmail" type="email" required maxLength={200} /></Field>
        <Field label="Precio del inmueble (USD)"><input name="price" inputMode="decimal" required /></Field>
        <Field label="Cuota inicial (USD)"><input name="deposit" inputMode="decimal" required value={deposit} onChange={(event) => setDeposit(event.target.value)} /></Field>
      </section>
      <section className="section form-grid">
        <h2 className="field-wide">Condiciones de la preventa</h2>
        <Field label="Punto de partida" wide><select value={startingPoint} onChange={(event) => setStartingPoint(event.target.value === 'blank' ? 'blank' : 'template')}>
          <option value="template">Plantilla de preventa</option><option value="blank">Empezar desde cero</option>
        </select></Field>
        <DraftConditions key={startingPoint} rows={drafts[startingPoint]} deposit={draftAmount(deposit)}
          onChange={(rows) => setDrafts((previous) => ({ ...previous, [startingPoint]: rows }))} />
      </section>
      <section className="section form-grid">
        <h2 className="field-wide">Contrato y resolución</h2>
        <Field label="Contrato firmado (opcional)" wide><input name="contract" type="file" accept=".pdf,.jpg,.jpeg,.png" /></Field>
        <div className="field-wide"><ResolverOptions mode={resolutionMode} email={arbiterEmail} onMode={setResolutionMode} onEmail={setArbiterEmail} /></div>
        <Field label="Plazo para responder una devolución"><input name="refundResponse" type="number" min={1} max={1440} defaultValue={72} required /></Field>
        <Field label="Unidad del plazo"><select name="refundUnit" defaultValue="hours">
          <option value="hours">Horas</option><option value="minutes">Minutos</option>
        </select></Field>
        <div className="field-wide"><Feedback error={task.error} /><Submit waiting={task.busy}>Revisar acuerdo</Submit></div>
      </section>
    </form>
  </>
}

function DraftConditions({ rows, deposit, onChange }: { rows: DraftCondition[]; deposit: number | null; onChange: (rows: DraftCondition[]) => void }) {
  const amounts = amountsForDraft(rows, deposit)
  const allocated = amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0)
  const [focus, setFocus] = useState<string | null>(null)
  useEffect(() => {
    if (!focus) return
    document.getElementById(focus)?.focus()
    setFocus(null)
  }, [focus])

  function update(index: number, changes: Partial<DraftCondition>) {
    onChange(rows.map((row, position) => position === index ? { ...row, ...changes } : row))
  }

  return <div className="field-wide draft-conditions">
    {rows.map((row, index) => {
      const position = index + 1
      const amount = amounts[index]
      return <fieldset key={row.id} className="condition-fieldset draft-condition">
        <legend>Condición {position}</legend>
        <div className="condition-controls" aria-label={'Opciones de la condición ' + position} role="group">
          <button className="icon-button" type="button" disabled={index === 0} aria-label={'Subir condición ' + position} title="Subir condición"
            onClick={() => onChange(moveCondition(rows, index, -1))}><ArrowUp size={19} aria-hidden="true" /></button>
          <button className="icon-button" type="button" disabled={position === rows.length} aria-label={'Bajar condición ' + position} title="Bajar condición"
            onClick={() => onChange(moveCondition(rows, index, 1))}><ArrowDown size={19} aria-hidden="true" /></button>
          <button className="icon-button" type="button" disabled={rows.length === 1} aria-label={'Quitar condición ' + position} title="Quitar condición"
            onClick={() => { onChange(rows.filter((item) => item.id !== row.id)); setFocus('condition-' + (rows[index + 1] ?? rows[index - 1]).id) }}>
            <Trash2 size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="form-grid">
          <Field label="Nombre de la condición"><input id={'condition-' + row.id} value={row.title} maxLength={120} required
            onChange={(event) => update(index, { title: event.target.value })} /></Field>
          <Field label="Fecha límite" help="Horario de Bolivia"><input type="datetime-local" value={row.dueAt} required
            onChange={(event) => update(index, { dueAt: event.target.value })} /></Field>
          <Field label="Qué debe cumplirse" wide><textarea value={row.condition} maxLength={600} required
            onChange={(event) => update(index, { condition: event.target.value })} /></Field>
          <Field label="Monto de la condición (USD)" help={row.amount === null ? 'Se calcula con la cuota inicial y los montos que asignes.' : undefined}>
            <input inputMode="decimal" value={row.amount ?? (amount === null ? '' : String(amount / 100))} required
              onChange={(event) => update(index, { amount: event.target.value })} />
          </Field>
        </div>
        {row.requirements.map((requirement, documentIndex) => <div key={requirement.key} className="requirement-edit">
          <Field label={'Documento requerido ' + (documentIndex + 1)}>
            <input id={requirement.key} value={requirement.label} maxLength={200} required onChange={(event) => {
              const label = event.target.value
              update(index, { requirements: row.requirements.map((item) => item.key === requirement.key ? { ...item, label } : item) })
            }} />
          </Field>
          <button className="icon-button" type="button" disabled={row.requirements.length === 1}
            aria-label={'Quitar documento ' + (documentIndex + 1) + ' de la condición ' + position} title="Quitar documento"
            onClick={() => {
              update(index, { requirements: row.requirements.filter((item) => item.key !== requirement.key) })
              setFocus((row.requirements[documentIndex + 1] ?? row.requirements[documentIndex - 1]).key)
            }}><Trash2 size={17} aria-hidden="true" /></button>
        </div>)}
        {row.requirements.length < MAX_REQUIREMENTS && <button className="text-button" type="button" onClick={() => {
          const next = draftRequirement()
          update(index, { requirements: [...row.requirements, next] })
          setFocus(next.key)
        }}><Plus size={16} aria-hidden="true" />Añadir documento</button>}
      </fieldset>
    })}
    <div className="button-row">
      {rows.length < MAX_CONDITIONS && <button className="button secondary" type="button" onClick={() => {
        const row = emptyCondition()
        onChange([...rows, row])
        setFocus('condition-' + row.id)
      }}><Plus size={18} aria-hidden="true" />Añadir condición</button>}
      {rows.some((row) => row.amount !== null) && <button className="text-button" type="button"
        onClick={() => onChange(rows.map((row) => ({ ...row, amount: null })))}>Repartir en partes iguales</button>}
    </div>
    {deposit !== null && <p className="draft-allocation" aria-live="polite">{money(allocated)} asignados de {money(deposit)}</p>}
  </div>
}

export function InvitationPage() {
  const { token = '' } = useParams()
  const invitation = read<Invitation>('/invitations/' + encodeURIComponent(token))
  const session = useSession()
  const task = useWork()
  const query = useQueryClient()
  const navigate = useNavigate()

  if (invitation.isPending || session.isPending) return <Loading>Abriendo tu invitación…</Loading>
  if (invitation.isError || session.isError) return <Feedback error={invitation.error ?? session.error} onRetry={() => {
    void invitation.refetch()
    void session.refetch()
  }} />
  const { opId, unit, unitDetail, project, deposit, sellerName, mine } = invitation.data
  const user = session.data.user
  const currentPath = invitationPath(token)
  return <div className="invitation">
    <section className="invitation-copy">
      <h1>{unit}<span>{project.name}</span></h1>
      <p className="muted">{unitDetail && <>{unitDetail}<br /></>}{project.city} · {sellerName}</p>
      <p>El desarrollador te invitó a revisar el acuerdo de preventa. Tu dinero queda protegido hasta que se cumpla cada condición.</p>
      <div className="invite-amount"><p>Cuota inicial</p><Amount cents={deposit} /></div>
      <Feedback error={task.error} />
      {!user ? <ActionLink to={'/entrar?volver=' + encodeURIComponent(currentPath)}>Entrar para ver el acuerdo</ActionLink> :
        !user.kind ? <ActionLink to={'/cuenta?volver=' + encodeURIComponent(currentPath)}>Completar mi perfil</ActionLink> :
          user.kind !== 'buyer' ? <Feedback error="Esta invitación requiere la cuenta de comprador que figura en el acuerdo." /> :
            mine ? <ActionLink to={operationPath(opId)}>Ver acuerdo</ActionLink> :
              <button className="button primary" type="button" disabled={task.busy} onClick={() => void task.run(async () => {
                const result = await write<{ opId: string }>('/invitations/' + encodeURIComponent(token) + '/claim')
                await query.invalidateQueries({ queryKey: ['/ops'] })
                navigate(operationPath(result.opId))
              })}>{task.busy ? 'Abriendo…' : 'Ver acuerdo'}<ArrowRight size={18} aria-hidden="true" /></button>}
    </section>
    <div className="invitation-plan"><AccessPlan /></div>
  </div>
}

export function ResolverInvitationPage() {
  const { token = '' } = useParams()
  const endpoint = '/resolver-invitations/' + encodeURIComponent(token)
  const invitation = read<ResolverInvitation>(endpoint)
  const session = useSession()
  const task = useWork()
  const query = useQueryClient()

  if (invitation.isPending || session.isPending) return <Loading>Abriendo tu invitación…</Loading>
  if (invitation.isError || session.isError) return <Feedback error={invitation.error ?? session.error} onRetry={() => {
    void invitation.refetch()
    void session.refetch()
  }} />
  const user = session.data.user
  const returnTo = encodeURIComponent(resolverInvitationPath(token))
  if (!invitation.data.mine) return <div className="invitation">
    <section className="invitation-copy">
      <h1>Invitación para un tercero</h1>
      <p>Entra con el correo al que se envió la invitación para ver los datos de la operación.</p>
      <ActionLink to={(user ? '/cuenta' : '/entrar') + '?volver=' + returnTo}>
        {user ? 'Ir a mi cuenta para cerrar sesión' : 'Entrar para ver la invitación'}
      </ActionLink>
    </section>
    <div className="invitation-plan"><AccessPlan /></div>
  </div>
  const { unit, project, sellerName, status } = invitation.data
  const accepted = status === 'accepted'

  return <div className="invitation">
    <section className="invitation-copy">
      <h1>{unit}<span>{project.name}</span></h1>
      <p className="muted">{project.city} · {sellerName}</p>
      <p>{accepted ? 'Aceptaste participar como tercero designado. Verás el caso cuando te corresponda intervenir.' :
        'El desarrollador te invitó a resolver devoluciones o desacuerdos como tercero designado en esta operación.'}</p>
      <Feedback error={task.error} />
      {!user ? <ActionLink to={'/entrar?volver=' + returnTo}>Entrar para ver la invitación</ActionLink> :
        !user.kind ? <ActionLink to={'/cuenta?volver=' + returnTo}>Completar mi perfil</ActionLink> :
            user.kind !== 'arbiter' ? <Feedback error="Esta invitación requiere una cuenta de tercero designado." /> :
              accepted ? <ActionLink to="/">Ver mis casos</ActionLink> :
                user.walletStatus !== 'active' ? <ActionLink to={'/cuenta?volver=' + returnTo}>Activar mi cuenta</ActionLink> :
                  <button className="button primary" type="button" disabled={task.busy} onClick={() => void task.run(async () => {
                    await write(endpoint + '/claim')
                    query.setQueryData<ResolverInvitation>([endpoint], (current) => current?.mine ? { ...current, status: 'accepted' } : current)
                    void query.invalidateQueries({ queryKey: ['/ops'] })
                  })}>{task.busy ? 'Confirmando…' : 'Aceptar designación'}<ArrowRight size={18} aria-hidden="true" /></button>}
    </section>
    <div className="invitation-plan"><AccessPlan /></div>
  </div>
}
