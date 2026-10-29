// The guardian's web UI, exposed as a StartOS interface.
//
// The service listens on 0.0.0.0:3000 inside its container (env PORT). It is the only
// listener; the guardian opens no other inbound port.
//
// TODO(verify): the interface-definition API of the 0.4 SDK (createInterface, the
// interface type 'ui', and how it is exported from main).
export const UI_PORT = 3000
export const UI_INTERFACE_ID = 'ui'
