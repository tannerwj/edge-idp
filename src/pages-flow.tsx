import { AuthLayout } from "./ui/layout";
import type { Ui } from "./ui/layout";
import { Icon } from "./ui/icons";
import type { IconName } from "./ui/icons";

export function TokenFormPage(props: {
  ui: Ui;
  title: string;
  lede: string;
  action: string;
  button: string;
  icon?: IconName;
}) {
  return (
    <AuthLayout ui={props.ui} title={props.title}>
      <div class="hero-icon">
        <Icon name={props.icon ?? "mail"} />
      </div>
      <h1>{props.title}</h1>
      <p class="lede">{props.lede}</p>
      <form method="post" action={props.action} data-fragment-token class="stack-sm">
        <input type="hidden" name="token" />
        <button class="btn primary lg block" type="submit">
          {props.button}
        </button>
        <p class="muted small" data-fragment-missing hidden>
          This link is incomplete. Open it straight from the email.
        </p>
      </form>
    </AuthLayout>
  );
}

export function DonePage(props: { ui: Ui; title: string; message: string; href?: string }) {
  return (
    <AuthLayout ui={props.ui} title={props.title}>
      <div class="hero-icon ok">
        <Icon name="check" />
      </div>
      <h1>{props.title}</h1>
      <p class="lede">{props.message}</p>
      <a class="btn block" href={props.href ?? "/"}>
        Continue to {props.ui.rpName}
      </a>
    </AuthLayout>
  );
}
