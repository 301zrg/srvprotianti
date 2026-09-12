# SRVProMonitor.ps1
# SRVPro Room Monitor Script (Pure PowerShell)

param(
    [string]$SrvProDir = "F:\MyCardLibrary\srvprotianti",
    [string]$ScriptName = "ygopro-server.js",
    [int]$Port = 7911,
    [int]$CheckInterval = 30,
    [string]$NodePath = "node",
    [switch]$Debug = $false
)

$LogFile = Join-Path $SrvProDir "monitor.log"

function Write-Log {
    param(
        [string]$Message,
        [string]$Level = "INFO"
    )
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogMessage = "[$Timestamp] [$Level] $Message"
    Write-Host $LogMessage
    Add-Content -Path $LogFile -Value $LogMessage -Encoding UTF8
}

function Start-SRVPro {
    $ScriptPath = Join-Path $SrvProDir $ScriptName
    
    if (-not (Test-Path $ScriptPath)) {
        Write-Log "Script file not found: $ScriptPath" "ERROR"
        return $null
    }
    
    Write-Log "Starting SRVPro: $ScriptPath"
    
    Push-Location $SrvProDir
    
    $ProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
    $ProcessInfo.FileName = $NodePath
    $ProcessInfo.Arguments = $ScriptName
    $ProcessInfo.WorkingDirectory = $SrvProDir
    $ProcessInfo.UseShellExecute = $false
    $ProcessInfo.RedirectStandardOutput = $true
    $ProcessInfo.RedirectStandardError = $true
    $ProcessInfo.CreateNoWindow = $true
    
    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = $ProcessInfo
    $Process.Start() | Out-Null
    
    $Process.BeginOutputReadLine()
    $Process.BeginErrorReadLine()
    
    Pop-Location
    
    Write-Log "SRVPro started (PID: $($Process.Id))"
    
    Start-Sleep -Seconds 5
    
    return $Process
}

function Stop-SRVPro {
    param([System.Diagnostics.Process]$Process)
    
    if ($Process -and (-not $Process.HasExited)) {
        Write-Log "Stopping SRVPro (PID: $($Process.Id))"
        try {
            $Process.Kill()
            $Process.WaitForExit(10000) | Out-Null
            Write-Log "SRVPro stopped"
        } catch {
            Write-Log "Failed to stop process: $_" "ERROR"
            try {
                taskkill /F /T /PID $Process.Id 2>$null
                Write-Log "Stopped using taskkill"
            } catch {
                Write-Log "taskkill also failed: $_" "ERROR"
            }
        }
    }
}

function Get-RoomList {
    $ApiUrl = "http://localhost:$Port/room/list"
    
    try {
        $Response = Invoke-WebRequest -Uri $ApiUrl -Method Get -TimeoutSec 5 -ErrorAction Stop
        $Content = $Response.Content
        
        $Data = $Content | ConvertFrom-Json
        
        if ($Data.rooms) {
            return $Data.rooms
        } elseif ($Data.room_list) {
            return $Data.room_list
        } else {
            return $Data
        }
        
    } catch {
        if ($Debug) {
            Write-Log "Failed to get room list: $($_.Exception.Message)" "DEBUG"
        }
        return $null
    }
}

function Has-ActiveRooms {
    param($Rooms)
    
    if ($null -eq $Rooms) {
        return $false
    }
    
    foreach ($Room in $Rooms) {
        $PlayerCount = 0
        
        if ($Room.player_count -ne $null) {
            $PlayerCount = $Room.player_count
        } elseif ($Room.PlayerCount -ne $null) {
            $PlayerCount = $Room.PlayerCount
        } elseif ($Room.count -ne $null) {
            $PlayerCount = $Room.count
        }
        
        if ($PlayerCount -gt 0) {
            return $true
        }
    }
    
    return $false
}

function Main {
    Write-Log "============================================================"
    Write-Log "SRVPro Room Monitor Started (Windows PowerShell)"
    Write-Log "Monitor Dir: $SrvProDir"
    Write-Log "API URL: http://localhost:$Port/room/list"
    Write-Log "Check Interval: ${CheckInterval}s"
    Write-Log "============================================================"
    
    try {
        $NodeVersion = & $NodePath --version 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Node.js not installed"
        }
        Write-Log "Node.js version: $NodeVersion"
    } catch {
        Write-Log "Node.js not found, please install Node.js" "ERROR"
        exit 1
    }
    
    $ScriptPath = Join-Path $SrvProDir $ScriptName
    if (-not (Test-Path $ScriptPath)) {
        Write-Log "SRVPro script not found: $ScriptPath" "ERROR"
        exit 1
    }
    
    $SrvProProcess = Start-SRVPro
    if (-not $SrvProProcess) {
        Write-Log "Failed to start SRVPro" "ERROR"
        exit 1
    }
    
    try {
        $NeedRestart = $false
        
        while ($true) {
            if ($SrvProProcess.HasExited) {
                Write-Log "SRVPro exited unexpectedly (ExitCode: $($SrvProProcess.ExitCode))" "WARN"
                $NeedRestart = $true
                break
            }
            
            $Rooms = Get-RoomList
            
            if ($null -eq $Rooms) {
                if ($Debug) {
                    Write-Log "Cannot get room list, waiting..." "DEBUG"
                }
            } else {
                $RoomCount = $Rooms.Count
                
                $ActiveCount = 0
                foreach ($Room in $Rooms) {
                    $PlayerCount = 0
                    if ($Room.player_count -ne $null) {
                        $PlayerCount = $Room.player_count
                    } elseif ($Room.PlayerCount -ne $null) {
                        $PlayerCount = $Room.PlayerCount
                    } elseif ($Room.count -ne $null) {
                        $PlayerCount = $Room.count
                    }
                    if ($PlayerCount -gt 0) { $ActiveCount++ }
                }
                
                if ($Debug) {
                    Write-Log "Total rooms: $RoomCount, Active rooms: $ActiveCount" "DEBUG"
                }
                
                $HasActive = Has-ActiveRooms -Rooms $Rooms
                if (-not $HasActive) {
                    Write-Log "All rooms are empty (Total: $RoomCount), restarting SRVPro..." "INFO"
                    $NeedRestart = $true
                    break
                }
            }
            
            Start-Sleep -Seconds $CheckInterval
        }
        
    } catch {
        Write-Log "Monitor error: $_" "ERROR"
        $NeedRestart = $true
    } finally {
        Write-Log "Restarting SRVPro..." "INFO"
        
        Stop-SRVPro -Process $SrvProProcess
        
        Start-Sleep -Seconds 2
        
        $NewProcess = Start-SRVPro
        if ($NewProcess) {
            Write-Log "SRVPro restart success (New PID: $($NewProcess.Id))" "INFO"
        } else {
            Write-Log "SRVPro restart failed" "ERROR"
        }
        
        Write-Log "Monitor task completed, exiting" "INFO"
        Write-Log "============================================================"
    }
}

Main