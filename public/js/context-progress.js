// context-progress.js — topbar 额度状态组件（圆点颜色 + hover tooltip 显示重置时间）
export class ContextProgress {
  constructor(container) {
    this._container = container;
    this._ratelimitState = 'normal'; // 'normal' | 'warning' | 'danger'
    this._resetsAt = null; // unix timestamp (seconds) or null
    this._render();
  }

  _render() {
    const c = this._container;

    this._dot = document.createElement('div');
    this._dot.className = 'cp-dot';

    this._tooltip = document.createElement('div');
    this._tooltip.className = 'cp-tooltip';
    this._ttLine1 = document.createElement('div');
    this._ttLine1.textContent = '额度正常';
    this._tooltip.appendChild(this._ttLine1);

    c.appendChild(this._dot);
    c.appendChild(this._tooltip);

    c.addEventListener('mouseenter', () => this._tooltip.classList.add('visible'));
    c.addEventListener('mouseleave', () => this._tooltip.classList.remove('visible'));
  }

  _refreshDot() {
    this._dot.classList.remove('warning', 'danger');
    if (this._ratelimitState !== 'normal') this._dot.classList.add(this._ratelimitState);
  }

  _refreshTooltip() {
    if (this._resetsAt != null) {
      const diffSec = Math.max(0, this._resetsAt - Math.floor(Date.now() / 1000));
      const diffMin = Math.round(diffSec / 60);
      const stateLabel = this._ratelimitState === 'danger' ? '额度已用尽' : '额度接近上限';
      this._ttLine1.textContent = `${stateLabel} · ${diffMin} 分钟后重置`;
    } else {
      const labels = { normal: '额度正常', warning: '额度接近上限', danger: '额度已用尽' };
      this._ttLine1.textContent = labels[this._ratelimitState] || '额度正常';
    }
  }

  updateRatelimitState(state, resetsAt) {
    this._ratelimitState = state || 'normal';
    this._resetsAt = resetsAt != null ? resetsAt : null;
    this._refreshDot();
    this._refreshTooltip();
  }

  show() { this._container.hidden = false; }
  hide() { this._container.hidden = true; }
}
