#include <windows.h>

typedef BOOL (WINAPI *WaitOnAddressFn)(volatile VOID *, PVOID, SIZE_T, DWORD);
typedef VOID (WINAPI *WakeByAddressFn)(PVOID, SIZE_T);

BOOL WaitOnAddress(volatile VOID *addr, PVOID compare, SIZE_T size, DWORD timeout) {
    static WaitOnAddressFn fn;
    if (!fn) {
        fn = (WaitOnAddressFn)GetProcAddress(GetModuleHandleA("kernel32.dll"), "WaitOnAddress");
        if (!fn) fn = (WaitOnAddressFn)GetProcAddress(GetModuleHandleA("kernelbase.dll"), "WaitOnAddress");
    }
    if (!fn) return FALSE;
    return fn(addr, compare, size, timeout);
}

VOID WakeByAddressSingle(PVOID addr) {
    static WakeByAddressFn fn;
    if (!fn) {
        fn = (WakeByAddressFn)GetProcAddress(GetModuleHandleA("kernel32.dll"), "WakeByAddressSingle");
        if (!fn) fn = (WakeByAddressFn)GetProcAddress(GetModuleHandleA("kernelbase.dll"), "WakeByAddressSingle");
    }
    if (fn) fn(addr, 0);
}

VOID WakeByAddressAll(PVOID addr) {
    static WakeByAddressFn fn;
    if (!fn) {
        fn = (WakeByAddressFn)GetProcAddress(GetModuleHandleA("kernel32.dll"), "WakeByAddressAll");
        if (!fn) fn = (WakeByAddressFn)GetProcAddress(GetModuleHandleA("kernelbase.dll"), "WakeByAddressAll");
    }
    if (fn) fn(addr, 0);
}
