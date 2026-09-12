<script setup>
import { computed, ref } from 'vue'

// ============================================================================
// StripDiagram —— 横向布局条（内存块 / 文件分区 / 记录序列）
// ----------------------------------------------------------------------------
// 为什么不用 mermaid 画这类图：
//   内存布局本质是"一段连续空间从左到右切成若干段，每段有名字和说明"。
//   这种图语义上是一条线，但 mermaid 的布局算法对"带 subgraph 的 TB 图"
//   倾向于把节点排成横排，结果局部宽度失控（实测出现过 3790px，
//   而正文栏只有 688px，读者只能看到 18%）。
//   所以这类图用专用组件画：宽度自适应容器，不给读者横向滚动的负担。
//
// 用法：
//   <StripDiagram
//     title="一块 256MB 虚拟预留里的 16 个 Pool 槽位"
//     :segments="[
//       { label: 'MBInfo', sub: '块头', kind: 'head', note: '管理本块内所有 Pool' },
//       { label: 'Pool #1', sub: '16MB', kind: 'pool' },
//       { label: '…', kind: 'more' },
//     ]"
//     :legend="[{ kind: 'head', text: '块头' }, …]"
//     footnote="可选：一句话补充" />
//
// kind 决定配色：head 块头 / pool 池 / used 已用 / free 空闲 / meta 元数据 /
//               data 数据 / more 省略号 / warn 风险段
// ============================================================================

const props = defineProps({
  segments: { type: Array, required: true },
  title: { type: String, default: '' },
  legend: { type: Array, default: () => [] },
  footnote: { type: String, default: '' },
  // 是否显示段宽（按 weight 比例宽度）
  showWidth: { type: Boolean, default: true },
  // 点击高亮（纯展示，无业务逻辑）
  highlight: { type: Number, default: -1 },
})

const KIND = {
  head: { bg: '#4C6EF5', fg: '#fff' },
  meta: { bg: '#868E96', fg: '#fff' },
  pool: { bg: '#12B886', fg: '#fff' },
  used: { bg: '#4C6EF5', fg: '#fff' },
  free: { bg: '#DEE2E6', fg: '#212529' },
  data: { bg: '#F59F00', fg: '#212529' },
  warn: { bg: '#FFA8A8', fg: '#212529' },
  more: { bg: 'transparent', fg: 'var(--vp-c-text-3)' },
}

function style(s) {
  return KIND[s.kind] || KIND.pool
}

// 宽度按 weight（默认 1）；more 段固定窄一点
function flexOf(s) {
  if (s.kind === 'more') return 0.35
  return s.weight || 1
}

const hovered = ref(-1)
</script>

<template>
  <figure class="sd-root">
    <figcaption v-if="title" class="sd-title">{{ title }}</figcaption>

    <div class="sd-strip">
      <div
        v-for="(s, i) in segments"
        :key="i"
        class="sd-seg"
        :class="{ hi: highlight === i, dim: hovered >= 0 && hovered !== i, more: s.kind === 'more' }"
        :style="{
          flex: flexOf(s) + ' 1 0',
          background: style(s).bg,
          color: style(s).fg,
        }"
        :title="`${s.label}${s.sub ? ' · ' + s.sub : ''}${s.note ? ' — ' + s.note : ''}`"
        @mouseenter="hovered = i"
        @mouseleave="hovered = -1"
      >
        <span class="sd-seg-label">{{ s.label }}</span>
        <span v-if="s.sub && showWidth" class="sd-seg-sub">{{ s.sub }}</span>
      </div>
    </div>

    <!-- 段说明清单：图上放不下的字放这里 -->
    <ul v-if="segments.some((s) => s.note)" class="sd-notes">
      <li
        v-for="(s, i) in segments"
        v-show="s.note"
        :key="i"
        :class="{ hot: hovered === i }"
        @mouseenter="hovered = i"
        @mouseleave="hovered = -1"
      >
        <i class="sd-dot" :style="{ background: style(s).bg }" />
        <b>{{ s.label }}</b>
        <span v-if="s.sub" class="sd-note-sub">{{ s.sub }}</span>
        <span class="sd-note-text">{{ s.note }}</span>
      </li>
    </ul>

    <div v-if="legend.length" class="sd-legend">
      <span v-for="(l, i) in legend" :key="i" class="sd-legend-item">
        <i class="sd-dot" :style="{ background: (KIND[l.kind] || KIND.pool).bg }" />{{ l.text }}
      </span>
    </div>

    <p v-if="footnote" class="sd-foot">{{ footnote }}</p>
  </figure>
</template>

<style scoped>
.sd-root {
  margin: 18px 0;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.sd-title { font-weight: 600; font-size: 14px; margin-bottom: 10px; }

.sd-strip {
  display: flex;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  min-width: 0;
}
.sd-seg {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.2;
  border-right: 1px solid rgba(255, 255, 255, 0.55);
  transition: opacity 0.15s;
  cursor: default;
  min-width: 0;
}
.sd-seg:last-child { border-right: 0; }
.sd-seg.dim { opacity: 0.42; }
.sd-seg.hi { box-shadow: inset 0 0 0 3px #F59F00; }
.sd-seg.more { border-right: 0; font-size: 16px; letter-spacing: 2px; }
.sd-seg-label {
  font-weight: 600;
  padding: 0 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.sd-seg-sub { opacity: 0.85; font-size: 10px; white-space: nowrap; }

.sd-notes {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}
.sd-notes li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 5px;
  flex-wrap: wrap;
}
.sd-notes li.hot { background: var(--vp-c-bg); }
.sd-dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
  flex: 0 0 auto;
  border: 1px solid var(--vp-c-divider);
}
.sd-notes b { color: var(--vp-c-text-1); }
.sd-note-sub {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
}
.sd-note-text { color: var(--vp-c-text-2); }

.sd-legend {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--vp-c-text-3);
}
.sd-legend-item { display: inline-flex; align-items: center; gap: 4px; }

.sd-foot {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--vp-c-text-3);
}
</style>
