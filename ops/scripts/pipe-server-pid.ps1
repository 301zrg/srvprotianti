param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$PipeName)
$ErrorActionPreference = 'Stop'
# GetNamedPipeServerProcessId identifies the kernel pipe endpoint, not a pid file.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PipeIdentity {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverPid);
}
'@
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
try {
    $pipe.Connect(2000)
    [uint32]$serverPid = 0
    if (-not [PipeIdentity]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$serverPid)) {
        throw 'pipe_identity_unavailable'
    }
    if ($serverPid -eq 0) { throw 'pipe_identity_unavailable' }
    [Console]::WriteLine($serverPid)
} finally {
    $pipe.Dispose()
}
