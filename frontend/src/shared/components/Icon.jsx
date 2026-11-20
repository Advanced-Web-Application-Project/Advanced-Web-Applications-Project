export default function Icon({ name, className = "" }) {
  return (
    <span className={`icon icon-${name} ${className}`} aria-hidden="true" />
  );
}
