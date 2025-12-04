import math
import numpy as np
from openpyxl import Workbook

FILE_NAME = 'analysis/marslink_analysis.xlsx'

sun_dist_earth_periapsis_km = 150000000
sun_dist_mars_apoapsis_km = 240000000
avg_sun_distance_km = (sun_dist_earth_periapsis_km +
                       sun_dist_mars_apoapsis_km) / 2
EM_km = sun_dist_mars_apoapsis_km - sun_dist_earth_periapsis_km

baseline_mbps = 100000
baseline_km = 3000
baseline_improvement = 10

# Total Mbps from In-ring satcount and Ring count
inring_satcount = 4
ring_count = 4


def total_mbps_worst(inring_satcount, ring_count):
    return baseline_improvement*baseline_mbps*baseline_km ** 2*inring_satcount ** 3 * \
        ring_count ** 2/((EM_km*inring_satcount) ** 2 +
                         (2*math.pi*avg_sun_distance_km*ring_count) ** 2)


def total_mbps_best(inring_satcount, ring_count):
    return baseline_improvement*baseline_mbps*baseline_km ** 2*inring_satcount * \
        ring_count ** 2/EM_km ** 2


total_satcount = inring_satcount * ring_count

total_mbps_per_total_satcount = total_mbps_worst(
    inring_satcount, ring_count) / total_satcount


# create an empty list which will contain tuples of (inring_satcount, optimal_ring_count, satcount_total, max_total_mbps_per_total_satcount, total_mbps_worst, total_mbps_best)
results = []
for inring_satcount in range(20, 5321, 20):
    max_mbps_per_sat = 0
    optimal_ring = 0
    for ring_count in range(1, 1000):
        total_mbps_worst_val = total_mbps_worst(inring_satcount, ring_count)
        total_satcount = inring_satcount * ring_count
        mbps_per_sat = total_mbps_worst_val / total_satcount
        if mbps_per_sat > max_mbps_per_sat:
            max_mbps_per_sat = mbps_per_sat
            optimal_ring = ring_count
        else:
            break  # since it will only decrease after this point
    # compute for optimal
    total_mbps_worst_opt = total_mbps_worst(inring_satcount, optimal_ring)
    total_mbps_best_opt = total_mbps_best(inring_satcount, optimal_ring)
    satcount_total = inring_satcount * optimal_ring
    results.append((inring_satcount, optimal_ring, satcount_total,
                   max_mbps_per_sat, total_mbps_worst_opt, total_mbps_best_opt))

# We do a linear regression (least squares) to find (a, b) for total_mbps_per_total_satcount = a * optimal_ring_count + b (across the inring satcount range)
# We do another linear regression optimal_ring_count = a * inring_satcount + b (but I expect b = 0) (across the inring satcount range)
inring_list = [r[0] for r in results]
optimal_ring_list = [r[1] for r in results]
mbps_per_sat_list = [r[3] for r in results]

a1, b1 = np.polyfit(optimal_ring_list, mbps_per_sat_list, 1)
a2, b2 = np.polyfit(inring_list, optimal_ring_list, 1)

print(f"Regression for mbps_per_sat vs optimal_ring: a={a1}, b={b1}")
print(f"Regression for optimal_ring vs inring: a={a2}, b={b2}")

# We have the list of tuples. They should be ordered by inring_satcount (from 100 to 10000)
target_total_mbps = 1000

# find the entry where total_mbps_worst is just above target_total_mbps
for r in results:
    if r[4] > target_total_mbps:
        print(f"inring_satcount: {r[0]}, optimal_ring_count: {r[1]}, satcount_total: {r[2]}, max_total_mbps_per_total_satcount: {r[3]}, total_mbps_worst: {r[4]}, total_mbps_best: {r[5]}")
        break

# now, fit both total_mbps_worst and total_mbps_best vs total_satcount with y = a x^b
total_sat_list = [r[2] for r in results]
worst_list = [r[4] for r in results]
best_list = [r[5] for r in results]

log_sat = np.log(total_sat_list)
log_worst = np.log(worst_list)
log_best = np.log(best_list)

b_worst, log_a_worst = np.polyfit(log_sat, log_worst, 1)
a_worst = np.exp(log_a_worst)

b_best, log_a_best = np.polyfit(log_sat, log_best, 1)
a_best = np.exp(log_a_best)

fitted_worst_list = [a_worst * s ** b_worst for s in total_sat_list]
fitted_best_list = [a_best * s ** b_best for s in total_sat_list]

print(f"Fit for total_mbps_worst: a={a_worst}, b={b_worst}")
print(f"Fit for total_mbps_best: a={a_best}, b={b_best}")

# save data to a .xlsx file
wb = Workbook()
ws = wb.active
ws.title = 'Data'
ws.append(['inring_satcount', 'optimal_ring_count', 'satcount_total', 'max_total_mbps_per_total_satcount',
          'total_mbps_worst', 'total_mbps_best', 'fitted_worst', 'fitted_best'])
for i, row in enumerate(results):
    ws.append(row + (fitted_worst_list[i], fitted_best_list[i]))

# add fits to another sheet
ws2 = wb.create_sheet('Fits')
ws2.append(['Description', 'a', 'b'])
ws2.append(['Regression mbps_per_sat vs optimal_ring', a1, b1])
ws2.append(['Regression optimal_ring vs inring', a2, b2])
ws2.append(['Fit total_mbps_worst', a_worst, b_worst])
ws2.append(['Fit total_mbps_best', a_best, b_best])

try:
    wb.save(FILE_NAME)
    print(f"Data saved to {FILE_NAME}")
except PermissionError:
    print(
        f"The Excel file '{FILE_NAME}' is currently open. Please close it and run the script again.")


# There is an analytical solution for the power-law fit parameters of total_mbps_worst_opt(N) vs. satcount_total = N * R_opt, where N = inring_satcount and R_opt = optimal ring_count.
#
# Key Insight
# The optimal R_opt that maximizes Mbps per satellite is derived by setting the derivative of Mbps/sat to zero:
#
# R_opt = alpha * N,   alpha = EM_km / (2 * pi * avg_sun_distance_km)
#
# This gives satcount_total = S = alpha * N^2.
#
# Substituting into total_mbps_worst:
#
# total_mbps_worst_opt(N) = [K * alpha^(1/2)] / [2 * EM_km^2] * S^(3/2)
#
# where K = baseline_improvement * baseline_mbps * baseline_km^2.
#
# Thus:
#
# - b_worst = 3/2 = 1.5 (exact, asymptotically for large N)
# - a_worst = [K * sqrt(alpha)] / [2 * EM_km^2] (constant, independent of specific N or R)
#
# total_mbps_best_opt(N) follows similarly:
#
# - b_best = 1.5
# - a_best = [K * sqrt(alpha)] / EM_km^2 (no factor of 2)
#
# Numerical Values (from constants)
# - alpha ≈ 0.07346
# - a_worst ≈ 1.506 × 10^-4
# - a_best ≈ 3.011 × 10^-4
#
# (The numerical fits differ slightly due to discrete N ≥ 20, integer R, and finite range; e.g., your b_best ≈ 1.396 approaches 1.5 for larger N.)
#
# These do not depend on specific inring_satcount or ring_count (global constants). To implement analytically in code, compute directly from constants—no loop or fit needed.
#
# For the linear regressions:
# - optimal_ring vs inring_satcount: slope = alpha, intercept = 0
# - mbps_per_sat_max vs optimal_ring: slope = K / (2 * EM_km^2), intercept = 0

alpha = EM_km / (2 * math.pi * avg_sun_distance_km)
K = baseline_improvement * baseline_mbps * baseline_km ** 2
a_worst = K * math.sqrt(alpha) / (2 * EM_km ** 2)
b_worst = 1.5
a_best = K * math.sqrt(alpha) / (EM_km ** 2)
b_best = 1.5
print(f"Analytical Fit for total_mbps_worst: a={a_worst}, b={b_worst}")
print(f"Analytical Fit for total_mbps_best: a={a_best}, b={b_best}")
