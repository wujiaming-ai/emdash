import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const activityRoot = style({ minWidth: 0 });
// 为旋转中的箭头预留空间，窄列长标题不能产生横向溢出。
globalStyle(`${activityRoot} > [role=button]`, { paddingRight: '3px' });
globalStyle(`${activityRoot} > [role=button] > span:last-child`, {
  width: '10px',
  height: '10px',
  lineHeight: '10px',
  flexShrink: 0,
  textAlign: 'center',
});
globalStyle(`${activityRoot} > [role=button] > span:first-child`, {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
});

export const activityHeader = style({
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  fontSize: vars.typeBodyFontSize,
});
export const activityLabel = style({
  display: 'block',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
});
