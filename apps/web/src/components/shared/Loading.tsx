import "./Loading.scss";

interface LoadingProps {
  message?: string;
}

export function Loading({ message }: LoadingProps) {
  return (
    <div className="loading-shell">
      <div className="loading-mark">
        <span className="logo-block" />
        <strong>Alpha Code</strong>
        {message && <small>{message}</small>}
      </div>
    </div>
  );
}

interface ErrorDisplayProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorDisplay({ message, onRetry }: ErrorDisplayProps) {
  return (
    <div className="loading-shell">
      <div className="error-block">
        <strong>Alpha Code</strong>
        <p>{message}</p>
        {onRetry && (
          <button className="retry-btn" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
