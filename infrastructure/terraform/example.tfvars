# Copy to a local, UNCOMMITTED tfvars file and fill in.
# Real values are supplied at plan/apply time and never committed.
#
#   aws_account_id      = "000000000000"
#   connect_instance_id = "00000000-0000-0000-0000-000000000000"
#
# aws_region, environment and the qualification defaults are already set in
# variables.tf and rarely need overriding.
#
# simulator_enabled stays false until immediately before a controlled
# qualification call.
# simulator_enabled = false
