import { useState, type FormEvent } from "react";
import { CircleAlert, LogIn } from "lucide-react";
import { Brand } from "@/components/layout/Brand";
import { Button } from "@/components/ui/Button";
import { FieldLabel, PasswordInput, TextInput } from "@/components/ui/Fields";
import { errorMessage } from "@/services/api/client";
import { useLogin } from "@/queries";

export function LoginPage({ expired }: { expired?: boolean }) {
  const login = useLogin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setMissing(true);
      return;
    }
    setMissing(false);
    login.mutate({ username: username.trim(), password }, { onError: () => setPassword("") });
  }

  const error = missing ? "Completa el usuario y la contraseña." : login.isError ? errorMessage(login.error) : expired ? "Tu sesión terminó. Vuelve a ingresar." : null;

  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg px-5 pt-[max(48px,env(safe-area-inset-top))] pb-10 lg:justify-center lg:pt-10">
      <div className="flex w-full max-w-[400px] flex-col gap-8">
        <Brand large className="lg:self-center" />
        <form
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-6 lg:rounded-[14px] lg:border lg:border-border lg:bg-surface lg:p-8"
          aria-labelledby="login-title"
        >
          <div className="flex flex-col gap-1.5">
            <h1 id="login-title" className="text-2xl font-semibold tracking-[-0.5px] text-fg">
              Iniciar sesión
            </h1>
            <p className="text-[15px] text-fg-2">Ingresa con tu usuario y contraseña.</p>
          </div>

          {error ? (
            <div className="flex items-start gap-2 rounded-[10px] bg-danger-soft px-3.5 py-3" role="alert">
              <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
              <p className="text-sm leading-5 text-danger">{error}</p>
            </div>
          ) : null}

          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-2">
              <FieldLabel>Usuario</FieldLabel>
              <TextInput
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-invalid={missing && !username.trim() ? true : undefined}
              />
            </label>
            <label className="flex flex-col gap-2">
              <FieldLabel>Contraseña</FieldLabel>
              <PasswordInput
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={missing && !password ? true : undefined}
              />
            </label>
          </div>

          <Button type="submit" size="lg" icon={LogIn} loading={login.isPending} className="w-full">
            Ingresar
          </Button>
        </form>
        <p className="text-center text-[13px] text-fg-3">¿No tienes usuario? Pídeselo al administrador de la obra.</p>
      </div>
    </main>
  );
}
