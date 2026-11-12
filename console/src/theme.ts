import { createTheme } from '@mui/material/styles'

export const statusColors = {
  todo: '#fff',
  running: '#fff',
  done: '#fff',
  waitingBackground: '#fff9eb',
  waitingBorder: '#b88627',
  waitingText: '#8a5600',
  waitingBadge: '#ffe5ae',
}

export const theme = createTheme({
  palette: {
    primary: { main: '#0866ff' },
    success: { main: '#08a56d' },
    warning: { main: '#f59b00' },
    error: { main: '#db2e32' },
    text: { primary: '#202632', secondary: '#7a8190' },
    divider: '#e5e8ef',
    background: { default: '#fff', paper: '#fff' },
  },
  typography: {
    fontFamily: 'Inter, "Noto Sans SC", sans-serif',
    fontSize: 13,
    body1: { fontSize: 13, lineHeight: '21px' },
    body2: { fontSize: 12, lineHeight: '18px' },
    caption: { fontSize: 11, lineHeight: '16px' },
    h6: { fontSize: 15, fontWeight: 500, lineHeight: '22px' },
    button: { fontSize: 12, textTransform: 'none', fontWeight: 400 },
  },
  shape: { borderRadius: 6 },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true, size: 'small' },
      styleOverrides: {
        root: { minWidth: 0, minHeight: 28, padding: '3px 10px', gap: 6, lineHeight: '18px' },
        outlined: { borderColor: '#e5e8ef', color: '#202632' },
        startIcon: { margin: 0 },
        endIcon: { margin: 0 },
      },
    },
    MuiIconButton: {
      defaultProps: { size: 'small' },
      styleOverrides: { root: { width: 26, height: 26, padding: 5, borderRadius: 6 } },
    },
    MuiOutlinedInput: {
      defaultProps: { size: 'small' },
      styleOverrides: {
        root: { fontSize: 12, minHeight: 32 },
        input: { padding: '7px 10px' },
        notchedOutline: { borderColor: '#e5e8ef' },
      },
    },
    MuiSelect: { styleOverrides: { select: { padding: '6px 10px', fontSize: 12 } } },
    MuiMenuItem: { styleOverrides: { root: { fontSize: 12, minHeight: 36, gap: 8 } } },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          minHeight: 32,
          padding: '5px 8px',
          gap: 8,
          '&.Mui-selected': { background: '#eaf2ff', color: '#202632' },
        },
      },
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 12, boxShadow: '-6px 0 18px #1726401f' } },
    },
    MuiBackdrop: {
      styleOverrides: {
        root: {
          backgroundColor: '#20263229',
          '&.MuiBackdrop-invisible': { backgroundColor: 'transparent' },
        },
      },
    },
    MuiTabs: { styleOverrides: { root: { minHeight: 42 }, indicator: { height: 3 } } },
    MuiTab: {
      styleOverrides: {
        root: {
          minWidth: 54,
          minHeight: 42,
          fontSize: 12,
          padding: '8px',
          color: '#7a8190',
          '&.Mui-selected': { color: '#202632' },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        root: { width: 28, height: 16, padding: 0 },
        switchBase: {
          padding: 2,
          '&.Mui-checked': {
            transform: 'translateX(12px)',
            color: '#fff',
            '& + .MuiSwitch-track': { opacity: 1 },
          },
        },
        thumb: { width: 12, height: 12, boxShadow: 'none' },
        track: { borderRadius: 8, background: '#e5e8ef', opacity: 1 },
      },
    },
  },
})
