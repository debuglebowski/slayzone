/** Three matte dots: a flat bounce, two orbital turns, then back into line. */
export function LoadingDots() {
  return (
    <span className="loading-dots" aria-hidden="true">
      {[0, 1, 2].map((dot) => (
        <span key={dot} className="loading-dots-dot">
          <span className="loading-dots-bounce">
            <span className="loading-dots-seed" />
          </span>
        </span>
      ))}
    </span>
  )
}
