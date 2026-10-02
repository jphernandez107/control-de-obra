import { useState, type FormEvent } from "react";
import { CircleAlert, LogOut, ShieldCheck, UserPlus, Users } from "lucide-react";
import { Page, Footnote } from "@/components/layout/Page";
import { DesktopHeader, MobileHeader } from "@/components/layout/MobileHeader";
import { Button } from "@/components/ui/Button";
import { FieldLabel, PasswordInput, SelectInput, TextInput } from "@/components/ui/Fields";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { initialsOf } from "@/domain/format";
import { errorMessage } from "@/services/api/client";
import type { UserAccount, UserRole } from "@/services/types";
import { useCreateUser, useLogout, useSession, useUsers } from "@/queries";

const ROLE_LABEL: Record<string, string> = { propietario: "Propietario", ingeniero: "Ingeniero", otro: "Otro" };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

function Avatar({ name }: { name: string }) {
  return <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-fg-2">{initialsOf(name)}</span>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[15px] font-semibold text-fg">{children}</h2>;
}

function AccountCard() {
  const session = useSession();
  const logout = useLogout();
  const user = session.data?.user;
  if (!user) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Tu sesión</SectionTitle>
      <div className="flex items-center gap-3 rounded-[14px] border border-border bg-surface p-4">
        <Avatar name={user.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-[15px] font-medium text-fg">{user.name}</span>
          <span className="truncate text-[13px] text-fg-3">
            <span className="font-mono">{user.username}</span> · {roleLabel(user.role)}
          </span>
        </div>
        <Button variant="secondary" size="sm" icon={LogOut} loading={logout.isPending} onClick={() => logout.mutate()}>
          Cerrar sesión
        </Button>
      </div>
    </section>
  );
}

function UserRow({ user }: { user: UserAccount }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar name={user.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[15px] font-medium text-fg">{user.name}</span>
        <span className="truncate font-mono text-[13px] text-fg-3">{user.username}</span>
      </div>
      {user.isAdmin ? (
        <span className="inline-flex h-6 shrink-0 items-center gap-[5px] rounded-xl bg-accent-soft px-[9px] text-xs font-medium text-accent">
          <ShieldCheck size={13} />
          Administrador
        </span>
      ) : null}
      <span className="hidden h-6 shrink-0 items-center rounded-xl bg-surface-2 px-[9px] text-xs font-medium text-fg-2 sm:inline-flex">{roleLabel(user.role)}</span>
    </li>
  );
}

function UserList() {
  const users = useUsers();
  if (users.isPending) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-[60px] w-full" />
        ))}
      </div>
    );
  }
  if (users.isError) return <ErrorState title="No pudimos cargar los usuarios" onRetry={() => void users.refetch()} retrying={users.isFetching} />;
  if (!users.data.length) return <EmptyState icon={Users} title="Todavía no hay usuarios" />;
  return <ul className="divide-y divide-border rounded-[14px] border border-border bg-surface">{users.data.map((u) => <UserRow key={u.id} user={u} />)}</ul>;
}

const EMPTY = { name: "", username: "", password: "", role: "ingeniero" as UserRole };

function NewUserForm() {
  const create = useCreateUser();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      { ...form, name: form.name.trim(), username: form.username.trim() },
      {
        onSuccess: (user) => {
          toast(`${user.name} ya puede ingresar como «${user.username}».`);
          setForm(EMPTY);
        },
      },
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Agregar usuario</SectionTitle>
      <form onSubmit={submit} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-4 lg:p-5" autoComplete="off">
        {create.isError ? (
          <div className="flex items-start gap-2 rounded-[10px] bg-danger-soft px-3.5 py-3" role="alert">
            <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
            <p className="text-sm leading-5 text-danger">{errorMessage(create.error)}</p>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-2">
            <FieldLabel>Nombre</FieldLabel>
            <TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Marcelo Ríos" required maxLength={120} />
          </label>
          <label className="flex flex-col gap-2">
            <FieldLabel>Usuario</FieldLabel>
            <TextInput
              value={form.username}
              onChange={(e) => set({ username: e.target.value.toLowerCase() })}
              placeholder="marcelo"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              required
              maxLength={32}
              mono
            />
          </label>
          <label className="flex flex-col gap-2">
            <FieldLabel>Contraseña</FieldLabel>
            <PasswordInput value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" required minLength={8} />
          </label>
          <label className="flex flex-col gap-2">
            <FieldLabel>Rol</FieldLabel>
            <SelectInput value={form.role} onChange={(e) => set({ role: e.target.value as UserRole })}>
              <option value="propietario">Propietario</option>
              <option value="ingeniero">Ingeniero</option>
              <option value="otro">Otro</option>
            </SelectInput>
          </label>
        </div>
        <Footnote>Mínimo 8 caracteres. Comparte la contraseña en persona o por un canal privado; el usuario no puede cambiarla desde la app.</Footnote>
        <Button type="submit" icon={UserPlus} loading={create.isPending} className="self-stretch sm:self-start">
          Agregar usuario
        </Button>
      </form>
    </section>
  );
}

export function UsersPage() {
  const session = useSession();
  const isAdmin = session.data?.user.isAdmin ?? false;
  return (
    <Page>
      <MobileHeader eyebrow="Casa Córdoba" title="Usuarios" />
      <DesktopHeader title="Usuarios" subtitle="Personas que pueden ingresar a Control de Obra." />
      <div className="flex w-full max-w-[720px] flex-col gap-7 px-4 pt-2 lg:px-0 lg:pt-0">
        <AccountCard />
        {isAdmin ? (
          <>
            <section className="flex flex-col gap-3">
              <SectionTitle>Con acceso</SectionTitle>
              <UserList />
            </section>
            <NewUserForm />
          </>
        ) : (
          <Footnote>Solo el administrador puede agregar usuarios.</Footnote>
        )}
      </div>
    </Page>
  );
}
